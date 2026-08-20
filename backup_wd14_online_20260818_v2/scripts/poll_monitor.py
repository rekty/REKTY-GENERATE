#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pemantau otomatis status layanan chat Pollinations (VAIA Chat / Visual AI Artwork).

Cek tiap 5 menit (default):
  1) GET https://visualaiartwork.pages.dev/api/health   -> worker + KV hidup?
  2) GET https://gen.pollinations.ai/v1/models           -> gateway gen hidup?

Status DOWN baru dihitung setelah N kegagalan beruntun (default 3) supaya tidak
alarm palsu dari flakiness sesaat. Saat DOWN -> notifikasi Windows + log; saat
layanan pulih -> notifikasi "pulih".

Cara pakai:
  python scripts/poll_monitor.py            # mode watch: jalan terus, cek tiap 5 menit
  python scripts/poll_monitor.py --once     # cek sekali lalu keluar (untuk Task Scheduler)
  python scripts/poll_monitor.py --watch --interval 300 --consec 3
  python scripts/poll_monitor.py --chat-test   # tambah tes chat nyata (POST kecil, pakai pollen)
  python scripts/poll_monitor.py --silent      # tanpa output layar (hanya log + notifikasi)

Task Scheduler (tiap 5 menit, tanpa window):
  schtasks /Create /TN "VAIA_PollMonitor" /TR "\"C:\\Users\\user\\AppData\\Local\\Programs\\Python\\Python312\\python.exe\" \"D:\\REKTY GENERATOR\\scripts\\poll_monitor.py\" --once --silent" /SC MINUTE /MO 5 /F
  (sesuaikan path python.exe sesuai instalasi)
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
LOG_FILE = os.path.join(PROJECT_DIR, '.freebuff', 'poll_monitor.log')
STATE_FILE = os.path.join(PROJECT_DIR, '.freebuff', 'poll_monitor_state.json')

HEALTH_URL = 'https://visualaiartwork.pages.dev/api/health'
GEN_MODELS_URL = 'https://gen.pollinations.ai/v1/models'
CHAT_URL = 'https://visualaiartwork.pages.dev/api/chat'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VAIA-Monitor/1.0'}


def log(msg, silent=False):
    line = "[{}] {}".format(datetime.datetime.now().isoformat(timespec='seconds'), msg)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass
    if not silent:
        print(line, flush=True)


def load_state():
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'consec_fail': 0, 'down': False, 'last_status': None}


def save_state(st):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(st, f)
    except Exception:
        pass


def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def http_post(url, payload, timeout=25):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=dict(UA, **{'Content-Type': 'application/json'}), method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode('utf-8', errors='replace')
        return r.status, body


def notify(title, msg):
    """Notifikasi Windows: coba toast (Win10/11), fallback popup WScript."""
    safe_title = title.replace("'", "''")
    safe_msg = msg.replace("'", "''")
    # 1) Toast modern (Windows PowerShell 5.1 + WinRT)
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; "
        "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); "
        "$n=$t.GetElementsByTagName('text'); "
        "$n.Item(0).AppendChild($t.CreateTextNode('{}'))|Out-Null; "
        "$n.Item(1).AppendChild($t.CreateTextNode('{}'))|Out-Null; "
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('VAIA Chat Monitor').Show([Windows.UI.Notifications.ToastNotification]$t)"
    ).format(safe_title, safe_msg)
    try:
        r = subprocess.run(['powershell', '-NoProfile', '-Command', ps], timeout=20,
                           capture_output=True, creationflags=0x08000000)  # CREATE_NO_WINDOW
        if r.returncode == 0:
            return
    except Exception:
        pass
    # 2) Fallback popup
    try:
        ps2 = "(New-Object -ComObject WScript.Shell).Popup('{}', 15, '{}', 64)".format(safe_msg, safe_title)
        subprocess.run(['powershell', '-NoProfile', '-Command', ps2], timeout=20,
                       capture_output=True, creationflags=0x08000000)
    except Exception:
        pass


def check_once(chat_test, timeout=15):
    """Return (up: bool, details: dict)."""
    details = {}
    try:
        details['worker'] = http_get(HEALTH_URL, timeout) == 200
    except Exception:
        details['worker'] = False
    try:
        details['gen_models'] = http_get(GEN_MODELS_URL, timeout) == 200
    except Exception:
        details['gen_models'] = False
    up = bool(details.get('worker') and details.get('gen_models'))
    if chat_test:
        try:
            status, body = http_post(CHAT_URL, {
                'messages': [{'role': 'user', 'content': 'ping monitor'}],
                'model': 'gpt-5.6-luna', 'stream': False, 'mode': 'kreatif',
            }, timeout=25)
            details['chat'] = (status == 200 and '"ok":true' in body)
            up = up and details['chat']
        except Exception:
            details['chat'] = False
            up = False
    return up, details


def run_once(args):
    st = load_state()
    up, details = check_once(args.chat_test)
    if up:
        if st.get('down'):
            log('LAYANAN PULIH — chat Pollinations kembali normal.', args.silent)
            notify('VAIA Chat Monitor — Pulih', 'Layanan chat Pollinations sudah kembali normal.')
        st['down'] = False
        st['consec_fail'] = 0
        log('OK worker={} gen={}{}'.format(
            details.get('worker'), details.get('gen_models'),
            ' chat={}'.format(details.get('chat')) if 'chat' in details else ''), args.silent)
    else:
        st['consec_fail'] = int(st.get('consec_fail', 0)) + 1
        if not st.get('down') and st['consec_fail'] >= args.consec:
            st['down'] = True
            log('!! LAYANAN DOWN ({}x gagal beruntun) worker={} gen={}{}'.format(
                st['consec_fail'], details.get('worker'), details.get('gen_models'),
                ' chat={}'.format(details.get('chat')) if 'chat' in details else ''), args.silent)
            notify('VAIA Chat Monitor — ⚠️ Layanan Down',
                   'Chat Pollinations bermasalah: worker={}, gen={}. Cek visualaiartwork.pages.dev.'.format(
                       'OK' if details.get('worker') else 'GAGAL',
                       'OK' if details.get('gen_models') else 'GAGAL'))
        else:
            log('Gagal {}/{} beruntun worker={} gen={}'.format(
                st['consec_fail'], args.consec, details.get('worker'), details.get('gen_models')), args.silent)
    st['last_status'] = 'up' if up else 'down'
    st['last_check'] = datetime.datetime.now().isoformat(timespec='seconds')
    save_state(st)
    return 0 if up else 1


def main():
    ap = argparse.ArgumentParser(description='Pemantau status layanan chat Pollinations (VAIA)')
    ap.add_argument('--watch', action='store_true', help='jalan terus (default kalau tanpa --once)')
    ap.add_argument('--once', action='store_true', help='cek sekali lalu keluar (untuk Task Scheduler)')
    ap.add_argument('--interval', type=int, default=300, help='detik antar cek (default 300)')
    ap.add_argument('--consec', type=int, default=3, help='jumlah gagal beruntun untuk dianggap DOWN (default 3)')
    ap.add_argument('--chat-test', action='store_true', help='tambah tes chat nyata (POST kecil, pakai pollen)')
    ap.add_argument('--silent', action='store_true', help='tanpa output layar (hanya log + notifikasi)')
    args = ap.parse_args()

    if args.once:
        sys.exit(run_once(args))

    log('Pemantau dimulai (interval {}s, down setelah {}x gagal){}'.format(
        args.interval, args.consec, ' + tes chat nyata' if args.chat_test else ''), args.silent)
    try:
        while True:
            run_once(args)
            time.sleep(max(30, args.interval))
    except KeyboardInterrupt:
        log('Pemantau dihentikan manual.', args.silent)
    except Exception as e:
        log('ERROR pemantau: {}'.format(e), args.silent)


if __name__ == '__main__':
    main()
