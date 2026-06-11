import openpyxl
import json
import os

DB_FILE = "db.json"
EXCEL_FILE = "User.xlsx"

def import_users():
    if not os.path.exists(EXCEL_FILE):
        print(f"Error: {EXCEL_FILE} does not exist.")
        return

    # 1. Read existing DB
    db_data = {"players": [], "matches": [], "predictions": [], "team_info": {}, "config": {}}
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                db_data = json.load(f)
        except Exception as e:
            print("Warning: Could not read db.json, creating new database structure.", e)

    # Index existing players by ID to preserve pin hashes
    existing_players = {p["id"]: p for p in db_data.get("players", [])}

    # 2. Parse Excel file
    new_players = []
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE, read_only=True)
        sheet = wb.active
        
        # Read rows, skip header (STT, full_name, username)
        rows = list(sheet.iter_rows(values_only=True))
        header = rows[0]
        
        # Find column indices
        name_idx = -1
        user_idx = -1
        
        for idx, col in enumerate(header):
            col_name = str(col).strip().lower()
            if col_name in ['full_name', 'name', 'tên', 'họ tên', 'họ và tên']:
                name_idx = idx
            elif col_name in ['username', 'id', 'user', 'tên đăng nhập', 'tài khoản']:
                user_idx = idx
                
        # Fallbacks if headers differ
        if name_idx == -1: name_idx = 1
        if user_idx == -1: user_idx = 2
        
        print(f"Mapping columns: full_name index={name_idx}, username index={user_idx}")

        count = 0
        for row in rows[1:]:
            if not row or len(row) <= max(name_idx, user_idx):
                continue
                
            full_name = row[name_idx]
            username = row[user_idx]
            
            if not full_name or not username:
                continue
                
            full_name = str(full_name).strip()
            username = str(username).strip().lower()
            
            player_id = f"p_{username}"
            
            # Preserve existing pin hash if player exists, else set default '1234' hash
            # sha256 of '1234' is '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'
            default_pin_hash = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4"
            pin_hash = default_pin_hash
            if player_id in existing_players:
                # If existing player has a custom PIN, keep it. If they had empty string, set default.
                exist_hash = existing_players[player_id].get("pin_hash", "")
                if exist_hash and exist_hash != "":
                    pin_hash = exist_hash
            
            new_players.append({
                "id": player_id,
                "name": full_name,
                "pin_hash": pin_hash
            })
            count += 1
            
        db_data["players"] = new_players
        
        # Write back to db.json
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(db_data, f, ensure_ascii=False, indent=2)
            
        print(f"Successfully imported {count} players from {EXCEL_FILE} into {DB_FILE}!")
        
    except Exception as e:
        print("Error importing users:", e)

if __name__ == "__main__":
    import_users()
