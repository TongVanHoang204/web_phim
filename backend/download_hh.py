import sys
import os
import subprocess
from playwright.sync_api import sync_playwright

def download_video(target_url):
    m3u8_url = None
    headers_dict = {}

    def handle_response(response):
        nonlocal m3u8_url, headers_dict
        if ".m3u8" in response.url and response.request.method == "GET":
            print(f"[FOUND HLS] {response.url}")
            m3u8_url = response.url
            headers = response.request.headers
            referer = headers.get("referer", "")
            user_agent = headers.get("user-agent", "")
            
            headers_dict['Referer'] = referer
            headers_dict['User-Agent'] = user_agent

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        page.on("response", handle_response)
        print(f"[NAVIGATING] {target_url}")
        
        try:
            page.goto(target_url, wait_until="networkidle")
            page.wait_for_timeout(10000)
            page.screenshot(path="screenshot.png")
            print("[SCREENSHOT SAVED]")
        except Exception as e:
            print(f"[ERROR] {e}")
        finally:
            browser.close()

    if m3u8_url:
        print(f"[M3U8 URL] {m3u8_url}")
        print(f"[HEADERS] {headers_dict}")
    else:
        print("[NOT FOUND]")

if __name__ == "__main__":
    url = "https://hhkungfu.ee/watch-gia-thien/tap-162-sv1.html"
    download_video(url)
