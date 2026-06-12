import json
import os

def migrate():
    db_path = os.path.join(os.path.dirname(__file__), "db.json")
    
    if not os.path.exists(db_path):
        print(f"Lỗi: Không tìm thấy file {db_path} trên server.")
        return
        
    print("Đang đọc database...")
    with open(db_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    updated_count = 0
    for match in data.get("matches", []):
        if "price" in match:
            # Chỉ chia cho 1000 nếu giá trị điểm vẫn đang ở hàng nghìn (ví dụ >= 1000)
            if match["price"] >= 1000:
                match["price"] = int(match["price"] / 1000)
                updated_count += 1
                
    if updated_count > 0:
        with open(db_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"Cập nhật thành công! Đã chuyển đổi điểm của {updated_count} trận đấu về hàng chục.")
    else:
        print("Database đã ở dạng hàng chục rồi, không cần cập nhật thêm.")

if __name__ == "__main__":
    migrate()
