import os
import json
import hashlib
import requests
import threading
from datetime import datetime, timedelta, timezone
from flask import Flask, request, jsonify, render_template

app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "wc2026_secret_key_office_pool")

DB_FILE = os.path.join(os.path.dirname(__file__), "db.json")
db_lock = threading.Lock()
sync_lock = threading.Lock()

# Stage to Price mapping
STAGE_PRICES = {
    "group-stage": 12,
    "round-of-32": 25,
    "round-of-16": 50,
    "quarterfinals": 70,
    "semifinals": 100,
    "3rd-place-match": 100,
    "final": 120
}

# Stage to Vietnamese name mapping
STAGE_NAMES = {
    "group-stage": "Vòng bảng",
    "round-of-32": "Vòng 32",
    "round-of-16": "Vòng 1/16",
    "quarterfinals": "Tứ Kết",
    "semifinals": "Bán Kết",
    "3rd-place-match": "Tranh Hạng 3",
    "final": "Chung Kết"
}

# --- DATABASE HELPERS ---
def load_db():
    with db_lock:
        if not os.path.exists(DB_FILE):
            return {"players": [], "matches": [], "predictions": [], "team_info": {}, "config": {"admin_pin": "Admin@123", "last_espn_sync": 0}}
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {"players": [], "matches": [], "predictions": [], "team_info": {}, "config": {"admin_pin": "Admin@123", "last_espn_sync": 0}}

def save_db(data):
    with db_lock:
        try:
            # Atomic write via temp file
            temp_file = DB_FILE + ".tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(temp_file, DB_FILE)
            return True
        except Exception as e:
            print(f"Error saving database: {e}")
            return False

# --- LOCK LOGIC ---
def is_match_locked(kickoff_iso_utc, current_dt_utc=None):
    """
    Checks if a match is locked for predictions.
    Rule: Closes at 10:00 PM (22:00) of the day before the match date in local time (GMT+7).
    """
    try:
        # Standardize timezone offset
        kickoff_iso_utc = kickoff_iso_utc.replace("Z", "+00:00")
        kickoff_utc = datetime.fromisoformat(kickoff_iso_utc)
    except Exception:
        # Fallback format parsing
        try:
            kickoff_utc = datetime.strptime(kickoff_iso_utc[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        except Exception:
            # Default fallback if unparseable
            return True

    # Convert kickoff to local time (GMT+7 for Vietnam)
    gmt7 = timezone(timedelta(hours=7))
    kickoff_local = kickoff_utc.astimezone(gmt7)
    
    # Match local date
    match_date = kickoff_local.date()
    
    # Lock date is match local date - 1 day
    lock_date = match_date - timedelta(days=1)
    
    # Lock time is 22:00 (10 PM) of that day in GMT+7
    lock_local = datetime.combine(lock_date, datetime.min.time()).replace(tzinfo=gmt7) + timedelta(hours=22)
    
    if current_dt_utc is None:
        current_dt_utc = datetime.now(timezone.utc)
        
    current_local = current_dt_utc.astimezone(gmt7)
    
    return current_local >= lock_local

# --- AUTH LOGIC ---
def verify_player_token(player_id, token, db_data):
    if not token or not player_id:
        return False
    # Find player
    player = next((p for p in db_data["players"] if p["id"] == player_id), None)
    if not player or not player.get("pin_hash"):
        return False
    # Verify stateless token
    expected_token = hashlib.sha256(f"{player_id}:{player['pin_hash']}".encode()).hexdigest()
    return expected_token == token

def verify_admin_token(token, db_data):
    admin_pin = db_data["config"].get("admin_pin", "Admin@123")
    expected_token = hashlib.sha256(f"admin:{admin_pin}".encode()).hexdigest()
    return token == expected_token or token == admin_pin

# --- CALCULATION ENGINE ---
def calculate_predictions_and_funds(db_data):
    """
    Computes all player statistics and expected fund pool dynamically based on finished matches.
    Only active players (those who have changed their PIN from the default '1234' AND made at least one prediction) are included.
    """
    DEFAULT_PIN_HASH = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4"
    
    active_player_ids = set()
    for p in db_data.get("players", []):
        pin_hash = p.get("pin_hash")
        has_changed_pin = (pin_hash is None) or (pin_hash != DEFAULT_PIN_HASH)
        
        has_prediction = any(
            pred["player_id"] == p["id"] and pred.get("selection") not in ["none", None]
            for pred in db_data.get("predictions", [])
        )
        
        if has_changed_pin and has_prediction:
            active_player_ids.add(p["id"])

    players_stats = {p["id"]: {
        "id": p["id"],
        "name": p["name"],
        "total_predicted": 0,
        "correct": 0,
        "half_loss": 0,
        "full_loss": 0,
        "total_contribution": 0
    } for p in db_data.get("players", []) if p["id"] in active_player_ids}

    # Index predictions by (match_id, player_id) for fast lookup
    pred_map = {(p["match_id"], p["player_id"]): p for p in db_data["predictions"]}

    finished_matches = [m for m in db_data["matches"] if m.get("finished")]

    for match in finished_matches:
        price = match.get("price", 12)
        scoreA = int(match.get("scoreA", 0))
        scoreB = int(match.get("scoreB", 0))
        
        # Determine actual outcome
        if scoreA > scoreB:
            actual = "teamA"
        elif scoreB > scoreA:
            actual = "teamB"
        else:
            actual = "draw"

        for p_id in players_stats.keys():
            pred = pred_map.get((match["id"], p_id))
            
            if not pred:
                # Rule 4: No prediction -> Full loss
                players_stats[p_id]["full_loss"] += 1
                players_stats[p_id]["total_contribution"] += price
            elif pred.get("violated"):
                # Rule 3: Violated/Disqualified prediction -> Full loss
                players_stats[p_id]["total_predicted"] += 1
                players_stats[p_id]["full_loss"] += 1
                players_stats[p_id]["total_contribution"] += price
            else:
                selection = pred.get("selection")
                players_stats[p_id]["total_predicted"] += 1
                
                if selection == "draw":
                    if actual == "draw":
                        # Rule 2: Picked draw, actual draw -> 0 VND
                        players_stats[p_id]["correct"] += 1
                    else:
                        # Rule 2: Picked draw, actual win/loss -> Full loss
                        players_stats[p_id]["full_loss"] += 1
                        players_stats[p_id]["total_contribution"] += price
                elif selection in ["teamA", "teamB"]:
                    if selection == actual:
                        # Rule 1: Picked team wins -> 0 VND
                        players_stats[p_id]["correct"] += 1
                    elif actual == "draw":
                        # Rule 1: Picked team, actual draw -> 1/2 price
                        players_stats[p_id]["half_loss"] += 1
                        players_stats[p_id]["total_contribution"] += int(price / 2)
                    else:
                        # Rule 1: Picked team loses -> Full loss
                        players_stats[p_id]["full_loss"] += 1
                        players_stats[p_id]["total_contribution"] += price
                else:
                    # Invalid selection value -> Treat as no prediction
                    players_stats[p_id]["full_loss"] += 1
                    players_stats[p_id]["total_contribution"] += price

    total_fund = sum(p["total_contribution"] for p in players_stats.values())
    return list(players_stats.values()), total_fund

# --- ESPN API SCORE SYNCER ---
def sync_scores_from_espn(force=False):
    """
    Fetches live scores from ESPN's scoreboard API.
    Updates match scores, schedules, and finished statuses.
    """
    if not sync_lock.acquire(blocking=False):
        # Already syncing
        return False

    try:
        db_data = load_db()
        last_sync = db_data["config"].get("last_espn_sync", 0)
        now_ts = int(datetime.now(timezone.utc).timestamp())

        # Sync at most once every 5 minutes (300s) unless forced
        if not force and (now_ts - last_sync < 300) and len(db_data["matches"]) > 0:
            return False

        print("Syncing scores from ESPN...")
        url = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=150"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        
        try:
            response = requests.get(url, headers=headers, timeout=10)
            if response.status_code != 200:
                print(f"ESPN API returned status code {response.status_code}")
                return False
            data = response.json()
        except Exception as e:
            print(f"Network error calling ESPN API: {e}")
            return False

        events = data.get("events", [])
        if not events:
            print("No events found in ESPN API response")
            return False

        matches_map = {m["espn_id"]: m for m in db_data["matches"] if m.get("espn_id")}
        updated = False

        for event in events:
            espn_id = event.get("id")
            if not espn_id:
                continue

            comp = event.get("competitions", [{}])[0]
            competitors = comp.get("competitors", [])
            if len(competitors) < 2:
                continue

            # Determine Home/Away to map consistently
            home_comp = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
            away_comp = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])

            teamA_name = home_comp.get("team", {}).get("displayName", "Home Team")
            teamA_logo = home_comp.get("team", {}).get("logo", "")
            teamA_score = int(home_comp.get("score", 0))

            teamB_name = away_comp.get("team", {}).get("displayName", "Away Team")
            teamB_logo = away_comp.get("team", {}).get("logo", "")
            teamB_score = int(away_comp.get("score", 0))

            kickoff = event.get("date", "")
            status_desc = event.get("status", {}).get("type", {})
            status_name = status_desc.get("name", "")
            completed = status_desc.get("completed", False) or status_name == "STATUS_FINAL"

            stage_slug = event.get("season", {}).get("slug", "group-stage")
            price = STAGE_PRICES.get(stage_slug, 12)

            # Check if match exists in DB
            match = matches_map.get(espn_id)
            if match:
                # Update match scores/status if not finished or if scores changed
                # Do not override manual overrides if they were set (optional, here we auto-sync)
                if (match.get("scoreA") != teamA_score or 
                    match.get("scoreB") != teamB_score or 
                    match.get("finished") != completed or
                    match.get("kickoff") != kickoff):
                    
                    match["scoreA"] = teamA_score
                    match["scoreB"] = teamB_score
                    match["finished"] = completed
                    match["kickoff"] = kickoff
                    match["teamA_logo"] = teamA_logo
                    match["teamB_logo"] = teamB_logo
                    updated = True
            else:
                # Create a new match
                new_match = {
                    "id": f"m_{espn_id}",
                    "espn_id": espn_id,
                    "teamA": teamA_name,
                    "teamA_logo": teamA_logo,
                    "teamB": teamB_name,
                    "teamB_logo": teamB_logo,
                    "scoreA": teamA_score,
                    "scoreB": teamB_score,
                    "finished": completed,
                    "kickoff": kickoff,
                    "stage": stage_slug,
                    "price": price
                }
                db_data["matches"].append(new_match)
                matches_map[espn_id] = new_match
                updated = True

        # Sort matches by kickoff date
        db_data["matches"].sort(key=lambda m: m.get("kickoff", ""))

        db_data["config"]["last_espn_sync"] = now_ts
        save_db(db_data)
        print(f"ESPN Sync completed. Matches updated: {updated}")
        return True
    finally:
        sync_lock.release()

# Background syncer wrapper
def run_async_sync():
    threading.Thread(target=sync_scores_from_espn, kwargs={"force": False}).start()

# --- WEB CONTROLLERS ---

@app.route('/')
def index():
    return render_template("index.html")

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.json or {}
    username = data.get("username", "").strip()
    pin = data.get("pin", "").strip()

    if not username or not pin or len(pin) != 4 or not pin.isdigit():
        return jsonify({"error": "Tên đăng nhập hoặc mã PIN 4 số không hợp lệ"}), 400

    db_data = load_db()
    # Construct player ID from username as generated by import_users.py
    player_id = f"p_{username.lower()}"
    player = next((p for p in db_data["players"] if p["id"] == player_id), None)
    
    if not player:
        return jsonify({"error": "Tên đăng nhập (username) không tồn tại"}), 404

    pin_hash = hashlib.sha256(pin.encode()).hexdigest()

    if player.get("pin_hash") == "":
        # Set PIN for the first time
        player["pin_hash"] = pin_hash
        save_db(db_data)
    elif player["pin_hash"] != pin_hash:
        return jsonify({"error": "Mã PIN không chính xác"}), 401

    token = hashlib.sha256(f"{player['id']}:{player['pin_hash']}".encode()).hexdigest()
    # Check if they are using the default PIN '1234'
    needs_pin_change = (player["pin_hash"] == "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4")
    return jsonify({
        "token": token,
        "player_id": player["id"],
        "name": player["name"],
        "needs_pin_change": needs_pin_change
    })

@app.route('/api/data', methods=['GET'])
def api_get_data():
    db_data = load_db()
    
    # Auto background sync with ESPN if stale
    last_sync = db_data["config"].get("last_espn_sync", 0)
    now_ts = int(datetime.now(timezone.utc).timestamp())
    if now_ts - last_sync > 300 or len(db_data["matches"]) == 0:
        run_async_sync()

    # Get auth context
    client_player_id = request.headers.get("X-Player-ID")
    client_token = request.headers.get("Authorization")
    
    is_authenticated = verify_player_token(client_player_id, client_token, db_data)
    is_admin = verify_admin_token(client_token, db_data)

    # Calculate leaderboard stats
    players_stats, total_fund = calculate_predictions_and_funds(db_data)

    # Sanitize predictions to prevent cheating
    sanitized_predictions = []
    for pred in db_data["predictions"]:
        match_id = pred["match_id"]
        player_id = pred["player_id"]
        
        # Look up corresponding match to check lock status
        match = next((m for m in db_data["matches"] if m["id"] == match_id), None)
        if not match:
            continue
            
        locked = is_match_locked(match["kickoff"]) or match.get("finished", False)
        
        sanitized_pred = {
            "match_id": match_id,
            "player_id": player_id,
            "violated": pred.get("violated", False)
        }
        
        # Prediction details are visible only if:
        # 1. The match is locked (voting deadline passed)
        # 2. Or the prediction belongs to the requesting player
        # 3. Or the requester is an admin
        if locked or (is_authenticated and player_id == client_player_id) or is_admin:
            sanitized_pred["selection"] = pred.get("selection", "none")
        else:
            # Hide choice but indicate player HAS voted
            sanitized_pred["selection"] = "hidden" if pred.get("selection") else "none"

        sanitized_predictions.append(sanitized_pred)

    # Append locked attribute to matches object
    enhanced_matches = []
    for m in db_data["matches"]:
        em = dict(m)
        em["locked"] = is_match_locked(m["kickoff"]) or m.get("finished", False)
        em["stage_vn"] = STAGE_NAMES.get(m.get("stage", "group-stage"), "Vòng bảng")
        enhanced_matches.append(em)

    # Sanitize player profiles for UI dropdown (remove hashes)
    DEFAULT_PIN_HASH = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4"
    active_player_ids = set()
    for p in db_data.get("players", []):
        pin_hash = p.get("pin_hash")
        has_changed_pin = (pin_hash is None) or (pin_hash != DEFAULT_PIN_HASH)
        has_prediction = any(
            pred["player_id"] == p["id"] and pred.get("selection") not in ["none", None]
            for pred in db_data.get("predictions", [])
        )
        if has_changed_pin and has_prediction:
            active_player_ids.add(p["id"])

    ui_players = [
        {
            "id": p["id"],
            "name": p["name"],
            "has_pin": bool(p.get("pin_hash")),
            "is_active": p["id"] in active_player_ids
        }
        for p in db_data["players"]
    ]

    needs_pin_change = False
    if is_authenticated:
        player = next((p for p in db_data["players"] if p["id"] == client_player_id), None)
        if player and player.get("pin_hash") == "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4":
            needs_pin_change = True

    return jsonify({
        "players": ui_players,
        "leaderboard": players_stats,
        "matches": enhanced_matches,
        "predictions": sanitized_predictions,
        "team_info": {},
        "total_fund": total_fund,
        "current_time": datetime.now(timezone.utc).isoformat(),
        "needs_pin_change": needs_pin_change
    })

@app.route('/api/predict', methods=['POST'])
def api_predict():
    db_data = load_db()
    
    # Authenticate player
    client_player_id = request.headers.get("X-Player-ID")
    client_token = request.headers.get("Authorization")
    
    if not verify_player_token(client_player_id, client_token, db_data):
        return jsonify({"error": "Vui lòng đăng nhập lại để bình chọn"}), 401

    data = request.json or {}
    match_id = data.get("match_id")
    selection = data.get("selection")

    if selection not in ["teamA", "teamB", "draw", "none"]:
        return jsonify({"error": "Lựa chọn dự đoán không hợp lệ"}), 400

    match = next((m for m in db_data["matches"] if m["id"] == match_id), None)
    if not match:
        return jsonify({"error": "Không tìm thấy trận đấu"}), 404

    # Check lock deadline (Rule 6)
    if is_match_locked(match["kickoff"]) or match.get("finished", False):
        return jsonify({"error": "Trận đấu đã khóa bình chọn (hạn chót 22h ngày hôm trước)"}), 403

    # Update or add prediction
    pred = next((p for p in db_data["predictions"] if p["match_id"] == match_id and p["player_id"] == client_player_id), None)
    if pred:
        pred["selection"] = selection
        pred["violated"] = False  # Reset violation on self-update before lock
    else:
        db_data["predictions"].append({
            "match_id": match_id,
            "player_id": client_player_id,
            "selection": selection,
            "violated": False
        })

    save_db(db_data)
    return jsonify({"success": True, "message": "Bình chọn thành công!"})

@app.route('/api/change-pin', methods=['POST'])
def api_change_pin():
    db_data = load_db()
    client_player_id = request.headers.get("X-Player-ID")
    client_token = request.headers.get("Authorization")
    
    if not verify_player_token(client_player_id, client_token, db_data):
        return jsonify({"error": "Vui lòng đăng nhập lại để đổi PIN"}), 401
        
    data = request.json or {}
    new_pin = data.get("new_pin", "").strip()
    
    if not new_pin or len(new_pin) != 4 or not new_pin.isdigit():
        return jsonify({"error": "Mã PIN mới phải gồm 4 chữ số"}), 400
        
    if new_pin == "1234":
        return jsonify({"error": "Không được sử dụng mã PIN mặc định 1234"}), 400
        
    player = next((p for p in db_data["players"] if p["id"] == client_player_id), None)
    if not player:
        return jsonify({"error": "Không tìm thấy tài khoản"}), 404
        
    new_pin_hash = hashlib.sha256(new_pin.encode()).hexdigest()
    player["pin_hash"] = new_pin_hash
    
    save_db(db_data)
    
    # Generate a new token based on the new PIN hash
    new_token = hashlib.sha256(f"{client_player_id}:{new_pin_hash}".encode()).hexdigest()
    
    return jsonify({
        "success": True,
        "token": new_token,
        "message": "Đổi mã PIN thành công!"
    })

# --- ADMINISTRATIVE ENDPOINTS ---

@app.route('/api/admin/verify', methods=['POST'])
def api_admin_verify():
    data = request.json or {}
    pin = data.get("pin", "")
    db_data = load_db()
    
    if verify_admin_token(pin, db_data):
        admin_pin = db_data["config"].get("admin_pin", "Admin@123")
        token = hashlib.sha256(f"admin:{admin_pin}".encode()).hexdigest()
        return jsonify({"token": token})
    return jsonify({"error": "Mã PIN Admin không đúng"}), 401

@app.route('/api/admin/verify-token', methods=['POST'])
def api_admin_verify_token():
    """Re-verify an existing admin token (used when re-opening the admin panel)."""
    db_data = load_db()
    token = request.headers.get("Authorization", "")
    if verify_admin_token(token, db_data):
        return jsonify({"valid": True})
    return jsonify({"error": "Token không hợp lệ hoặc đã hết hạn"}), 401

@app.route('/api/admin/match', methods=['POST'])
def api_admin_match():
    db_data = load_db()
    token = request.headers.get("Authorization")
    if not verify_admin_token(token, db_data):
        return jsonify({"error": "Không có quyền truy cập Admin"}), 403

    data = request.json or {}
    match_id = data.get("id")
    
    match = next((m for m in db_data["matches"] if m["id"] == match_id), None)
    if not match:
        return jsonify({"error": "Không tìm thấy trận đấu"}), 404

    if "scoreA" in data:
        match["scoreA"] = int(data["scoreA"])
    if "scoreB" in data:
        match["scoreB"] = int(data["scoreB"])
    if "finished" in data:
        match["finished"] = bool(data["finished"])
    if "teamA" in data:
        match["teamA"] = data["teamA"]
    if "teamB" in data:
        match["teamB"] = data["teamB"]
    if "price" in data:
        match["price"] = int(data["price"])
    if "kickoff" in data:
        match["kickoff"] = data["kickoff"]
    if "stage" in data:
        match["stage"] = data["stage"]

    save_db(db_data)
    return jsonify({"success": True, "message": "Cập nhật trận đấu thành công!"})

@app.route('/api/admin/player', methods=['POST'])
def api_admin_player():
    db_data = load_db()
    token = request.headers.get("Authorization")
    if not verify_admin_token(token, db_data):
        return jsonify({"error": "Không có quyền truy cập Admin"}), 403

    data = request.json or {}
    action = data.get("action")
    player_id = data.get("id")
    name = data.get("name", "").strip()

    if action == "create":
        if not name:
            return jsonify({"error": "Tên không được để trống"}), 400
        # Prevent duplicate names
        if any(p["name"].lower() == name.lower() for p in db_data["players"]):
            return jsonify({"error": "Tên nhân viên đã tồn tại"}), 400
            
        new_id = f"player_{int(datetime.now().timestamp() * 1000)}"
        db_data["players"].append({
            "id": new_id,
            "name": name,
            "pin_hash": "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4" # Default PIN '1234'
        })
    elif action == "update":
        player = next((p for p in db_data["players"] if p["id"] == player_id), None)
        if not player:
            return jsonify({"error": "Không tìm thấy người chơi"}), 404
        if name:
            player["name"] = name
        if data.get("reset_pin"):
            player["pin_hash"] = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4" # Default PIN '1234'
    elif action == "delete":
        db_data["players"] = [p for p in db_data["players"] if p["id"] != player_id]
        # Remove all predictions of deleted player
        db_data["predictions"] = [pr for pr in db_data["predictions"] if pr["player_id"] != player_id]
    else:
        return jsonify({"error": "Hành động không hợp lệ"}), 400

    save_db(db_data)
    return jsonify({"success": True, "message": "Cập nhật danh sách nhân viên thành công!"})

@app.route('/api/admin/prediction-override', methods=['POST'])
def api_admin_prediction_override():
    db_data = load_db()
    token = request.headers.get("Authorization")
    if not verify_admin_token(token, db_data):
        return jsonify({"error": "Không có quyền truy cập Admin"}), 403

    data = request.json or {}
    match_id = data.get("match_id")
    player_id = data.get("player_id")
    selection = data.get("selection", "none")
    violated = data.get("violated", False)

    if selection not in ["teamA", "teamB", "draw", "none"]:
        return jsonify({"error": "Dự đoán không hợp lệ"}), 400

    pred = next((p for p in db_data["predictions"] if p["match_id"] == match_id and p["player_id"] == player_id), None)
    if pred:
        pred["selection"] = selection
        pred["violated"] = violated
    else:
        db_data["predictions"].append({
            "match_id": match_id,
            "player_id": player_id,
            "selection": selection,
            "violated": violated
        })

    save_db(db_data)
    return jsonify({"success": True, "message": "Ghi đè dự đoán thành công!"})

@app.route('/api/admin/sync', methods=['POST'])
def api_admin_sync():
    db_data = load_db()
    token = request.headers.get("Authorization")
    if not verify_admin_token(token, db_data):
        return jsonify({"error": "Không có quyền truy cập Admin"}), 403

    res = sync_scores_from_espn(force=True)
    if res:
        return jsonify({"success": True, "message": "Đồng bộ tỷ số thành công!"})
    else:
        return jsonify({"error": "Không có trận đấu mới hoặc xảy ra lỗi đồng bộ"}), 500



if __name__ == '__main__':
    # Initial score sync on startup in background
    print("Initial startup ESPN sync launch...")
    threading.Thread(target=sync_scores_from_espn, kwargs={"force": False}).start()
    app.run(host="0.0.0.0", port=5004, debug=True)
