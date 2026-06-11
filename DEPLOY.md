# Deploy lên Linux Server (Nginx + Waitress)

## 1. Clone repo về server

```bash
git clone <your-repo-url> /var/www/wc2026
cd /var/www/wc2026
```

## 2. Tạo virtualenv và cài dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 3. Khởi tạo database

```bash
cp db.example.json db.json
```

Sau đó chạy script import nhân viên:
```bash
python import_users.py
```

## 4. Cấu hình Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wc2026
sudo ln -s /etc/nginx/sites-available/wc2026 /etc/nginx/sites-enabled/
# Sửa 'your-domain.com' và alias path trong file config cho đúng
sudo nano /etc/nginx/sites-available/wc2026
sudo nginx -t          # Kiểm tra config
sudo systemctl reload nginx
```

## 5. Cài systemd service (tự khởi động cùng server)

```bash
sudo cp deploy/wc2026.service /etc/systemd/system/
# Sửa User, WorkingDirectory, và FLASK_SECRET_KEY cho đúng
sudo nano /etc/systemd/system/wc2026.service
sudo systemctl daemon-reload
sudo systemctl enable wc2026
sudo systemctl start wc2026
```

## 6. Kiểm tra

```bash
sudo systemctl status wc2026      # Xem trạng thái service
sudo journalctl -u wc2026 -f      # Xem log realtime
```

## Các lệnh quản lý

```bash
sudo systemctl restart wc2026     # Restart app
sudo systemctl stop wc2026        # Dừng app
sudo systemctl start wc2026       # Khởi động app
```

## Cấu trúc thư mục trên server

```
/var/www/wc2026/
├── app.py
├── wsgi.py             ← Entry point cho Waitress
├── db.json             ← Database (không đẩy lên git)
├── requirements.txt
├── venv/
├── static/
│   ├── css/
│   ├── js/
│   └── images/
└── templates/
```
