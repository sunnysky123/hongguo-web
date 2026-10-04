#!/usr/bin/env python3
"""驱动前端各标签页并截图，验证交互与渲染。"""
import json, subprocess, time, urllib.request, base64, sys, socket
import websocket

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

port = free_port()
proc = subprocess.Popen([
    '/usr/bin/chromium', '--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', f'--remote-debugging-port={port}',
    '--remote-allow-origins=*', '--window-size=1280,900', 'about:blank',
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    for _ in range(60):
        try:
            tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json', timeout=1))
            page = next((t for t in tabs if t['type'] == 'page'), None)
            if page: break
        except Exception: pass
        time.sleep(0.5)
    else:
        print('chromium 启动失败'); sys.exit(1)

    ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=60)
    mid = [0]
    def cmd(method, **params):
        mid[0] += 1
        ws.send(json.dumps({'id': mid[0], 'method': method, 'params': params}))
        while True:
            r = json.loads(ws.recv())
            if r.get('id') == mid[0]: return r

    def js(expr):
        r = cmd('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=False)
        res = r.get('result', {})
        if 'exceptionDetails' in r:
            return 'JS_ERROR: ' + json.dumps(r['exceptionDetails'])[:200]
        return res.get('result', {}).get('value')

    def snap(path):
        s = cmd('Page.captureScreenshot', format='png')
        d = s.get('result', {}).get('data')
        if d:
            open(path, 'wb').write(base64.b64decode(d))
            return True
        return False

    PROBE = """JSON.stringify({
      status: (document.getElementById('status')||{}).textContent,
      cards: document.querySelectorAll('.card').length,
      chips: document.querySelectorAll('.chip').length,
      heads: [...document.querySelectorAll('.section-head h2')].map(e=>e.textContent).join(' | '),
      viewText: (document.getElementById('view')||{}).innerText.slice(0,80),
    })"""

    cmd('Page.enable'); cmd('Runtime.enable')
    cmd('Emulation.setDeviceMetricsOverride', width=1280, height=900,
        deviceScaleFactor=2, mobile=False)
    cmd('Page.navigate', url='http://127.0.0.1:8000/ui')
    time.sleep(7)
    print('【推荐】', js(PROBE))

    for tab, wait, name in [('rank', 6, '榜单'), ('latest', 9, '最新'), ('browse', 7, '筛选')]:
        js(f"document.querySelector('.tab[data-tab=\\'{tab}\\']').click()")
        time.sleep(wait)
        print(f'【{name}】', js(PROBE))
        snap(f'/tmp/tab_{tab}.png')

    # 深色/浅色主题
    js("document.getElementById('themeBtn').click()")
    time.sleep(1.5)
    print('【浅色主题】theme =', js("document.documentElement.getAttribute('data-theme')"))
    snap('/tmp/light.png')

    # 搜索（需签名，验证错误提示是否友好）
    js("document.getElementById('themeBtn').click(); const s=document.getElementById('search'); s.value='都市'; s.dispatchEvent(new Event('input'))")
    time.sleep(8)
    print('【搜索】', js(PROBE))
    snap('/tmp/search.png')

    ws.close()
finally:
    proc.terminate()
    try: proc.wait(timeout=5)
    except Exception: proc.kill()
