"""
Production entry point - chạy Flask app bằng Waitress WSGI server trên cổng 5004.
Sử dụng: python wsgi.py
"""
import threading
from waitress import serve
from app import app, sync_scores_from_espn

if __name__ == '__main__':
    print("Starting ESPN sync on startup...")
    threading.Thread(target=sync_scores_from_espn, kwargs={"force": False}).start()
    print("Starting Waitress WSGI server on port 5004...")
    serve(app, host='127.0.0.1', port=5004, threads=4)
