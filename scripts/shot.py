#!/usr/bin/env python3
"""用 CDP 驱动 chromium 截图，验证前端页面在浏览器中实际渲染。"""
import json, subprocess, time, urllib.request, base64, sys, socket
import websocket

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

port = free_port()
proc = subprocess.Popen([
    '/usr/bin/chromium', '--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', f'--remote-debugging-port={port}',
    '--remote-allow-origins=*',
    '--window-size=1280,900', 'about:blank',
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

    ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=45)
    mid = [0]
    def cmd(method, **params):
        mid[0] += 1
        ws.send(json.dumps({'id': mid[0], 'method': method, 'params': params}))
        while True:
            r = json.loads(ws.recv())
            if r.get('id') == mid[0]: return r

    url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8000/ui'
    out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui.png'
    tab = sys.argv[3] if len(sys.argv) > 3 else 'home'

    cmd('Page.enable'); cmd('Runtime.enable')
    cmd('Emulation.setDeviceMetricsOverride', width=1280, height=900,
        deviceScaleFactor=2, mobile=False)
    cmd('Page.navigate', url=url)
    time.sleep(7)

    # 收集控制台错误
    logs = cmd('Runtime.evaluate', expression='JSON.stringify(window.__errs||[])',
               returnByValue=True)
    # 读取关键 DOM 状态
    probe = cmd('Runtime.evaluate', returnByValue=True, expression="""(() => {
      const cards = document.querySelectorAll('.card');
      const cvgs = document.querySelectorAll('.card .poster img');
      let loaded = 0;
      cvgs.forEach(i => { if (i.complete && i.naturalWidth > 0) loaded++; });
      return JSON.stringify({
        title: document.title,
        status: (document.getElementById('status')||{}).textContent,
        cards: cards.length,
        imgs: cvgs.length, imgsLoaded: loaded,
        firstTitle: (document.querySelector('.card .title')||{}).textContent || '',
        apiInfo: (document.getElementById('apiInfo')||{}).textContent || '',
        theme: document.documentElement.getAttribute('data-theme'),
        bodyH: document.body.scrollHeight,
      });
    })()""")
    print('页面状态:', probe.get('result', {}).get('value'))

    cmd('Page.captureScreenshot', format='png', captureBeyondViewport=True)
    shot = cmd('Page.captureScreenshot', format='png')
    data = shot.get('result', {}).get('data')
    if data:
        open(out, 'wb').write(base64.b64decode(data))
        print('截图已保存:', out)
    ws.close()
finally:
    proc.terminate()
    try: proc.wait(timeout=5)
    except Exception: proc.kill()
