const fs = require('fs');
const path = require('path');

module.exports = function attachUi(app) {
    // Serve the explorer UI
    app.get('/', (req, res) => {
        const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Infavy API Server</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root{--gap:16px}
      body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:16px;color:#111}
      h1{font-size:18px;margin:0 0 8px}
      .wrap{display:flex;gap:var(--gap);height:85vh}
      .left{width:360px;min-width:200px;border:1px solid #e6e6e6;border-radius:8px;padding:12px;overflow:auto}
      .right{flex:1;border:1px solid #e6e6e6;border-radius:8px;padding:12px;display:flex;flex-direction:column;overflow:hidden}
      .endpoint{padding:8px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;border:1px solid transparent}
      .endpoint + .endpoint{margin-top:8px}
      .endpoint.selected{background:#f0f8ff;border-color:#cbe6ff}
      .meta{font-size:13px;color:#333}
      .controls{display:flex;gap:8px}
      .controls button{padding:6px 8px}
      .pane{flex:1;display:flex;gap:8px;overflow:hidden}
      .pane .box{flex:1;overflow:auto;padding:8px;border-radius:6px;background:#fafafa;border:1px solid #eee}
      pre{white-space:pre-wrap;word-break:break-word}
      code{background:#f3f3f3;padding:2px 6px;border-radius:4px;font-family:monospace}
    </style>
  </head>
  <body>
    <h1>@infavy/api-server — API Explorer</h1>
    <div class="wrap">
      <div class="left">
        <div id="list">Loading endpoints…</div>
      </div>
      <div class="right">
        <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
          <div id="selectedLabel">Select an endpoint from the left</div>
          <div id="actions"></div>
        </div>
        <div class="pane">
          <div class="box"><strong>Response</strong>
            <div id="result">Result will appear here.</div>
          </div>
          <div class="box">
            <strong>Documentation</strong>
            <div id="docs">Documentation will appear here.</div>
          </div>
        </div>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify@2.4.0/dist/purify.min.js"></script>
    <script>
      let endpoints = [];
      let selected = null;

      async function load() {
        const res = await fetch('/api/endpoints');
        endpoints = await res.json();
        renderList();
      }

      function renderList(){
        const container = document.getElementById('list');
        container.innerHTML = '';
        endpoints.forEach((e, idx) => {
          const el = document.createElement('div');
          el.className = 'endpoint';
          el.innerHTML = '<div class="meta"><strong>' + e.method + '</strong> <code>' + e.url + '</code></div>';

          const controls = document.createElement('div');
          controls.className = 'controls';

          const run = document.createElement('button');
          run.textContent = 'Call';
          run.onclick = async (ev) => { ev.stopPropagation(); await callEndpoint(e); };
          controls.appendChild(run);

          if (e.doc) {
            const docBtn = document.createElement('button');
            docBtn.textContent = 'Doc';
            docBtn.onclick = async (ev) => { ev.stopPropagation(); await showDoc(e); };
            controls.appendChild(docBtn);
          }

          el.appendChild(controls);

          el.onclick = () => selectEndpoint(idx);
          container.appendChild(el);
        });
      }

      function selectEndpoint(idx){
        const prev = document.querySelector('.endpoint.selected');
        if (prev) prev.classList.remove('selected');
        const nodes = document.querySelectorAll('.endpoint');
        const node = nodes[idx];
        if (node) node.classList.add('selected');
        selected = endpoints[idx];
        document.getElementById('selectedLabel').textContent = selected.method + ' ' + selected.url;
        renderActions();
        // clear panes
        document.getElementById('result').textContent = 'Click "Call" to execute the endpoint.';
        document.getElementById('docs').textContent = selected.doc ? 'Click "Doc" to load documentation.' : 'No documentation available.';
      }

      function renderActions(){
        const actions = document.getElementById('actions');
        actions.innerHTML = '';
        if (!selected) return;
        const run = document.createElement('button');
        run.textContent = 'Call';
        run.onclick = () => callEndpoint(selected);
        actions.appendChild(run);

        if (selected.doc){
          const doc = document.createElement('button');
          doc.textContent = 'Doc';
          doc.onclick = () => showDoc(selected);
          actions.appendChild(doc);
        }
      }

      async function callEndpoint(e){
        const resultEl = document.getElementById('result');
        resultEl.textContent = 'Loading...';
        try {
          let opts = { method: e.method };

          // If this is the login endpoint, prompt for email & password first
          if (String(e.url).indexOf('/api/v1/auth/login') !== -1) {
            const creds = await showLoginModal();
            if (!creds) {
              resultEl.textContent = 'Cancelled by user';
              return;
            }
            opts = {
              method: e.method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: creds.email, password: creds.password })
            };
          }

          const r = await fetch(e.url, opts);
          const ct = r.headers.get('content-type') || '';
          // prefer parsing JSON when possible
          if (ct.includes('application/json')) {
            const j = await r.json();
            resultEl.innerHTML = '<h3>Status: ' + r.status + '</h3><pre>' + escapeHtml(JSON.stringify(j, null, 2)) + '</pre>';
            // after showing result, also show documentation if available
            if (e.doc) await showDoc(e);
            return;
          }

          const txt = await r.text();
          // try to parse text as JSON as a fallback
          try {
            const parsed = JSON.parse(txt);
            resultEl.innerHTML = '<h3>Status: ' + r.status + '</h3><pre>' + escapeHtml(JSON.stringify(parsed, null, 2)) + '</pre>';
            if (e.doc) await showDoc(e);
          } catch (e) {
            resultEl.innerHTML = '<h3>Status: ' + r.status + '</h3><pre>' + escapeHtml(txt) + '</pre>';
            if (e.doc) await showDoc(e);
          }
        } catch (err){
          resultEl.textContent = 'Error: ' + err.message;
        }
      }

        // Use simple window prompts to collect email and password (no HTML modal)
        function showLoginModal(){
          return new Promise((resolve) => {
            try {
              const email = window.prompt('Enter email:');
              if (email === null) return resolve(null); // user cancelled
              const password = window.prompt('Enter password:');
              if (password === null) return resolve(null);
              resolve({ email: String(email).trim(), password: String(password) });
            } catch (err) {
              // In non-browser envs or if prompt is unavailable, fallback to cancelling
              resolve(null);
            }
          });
        }

      async function showDoc(e){
        const docsEl = document.getElementById('docs');
        docsEl.textContent = 'Loading doc...';
        try {
          const dres = await fetch('/api/docs/' + e.doc);
          if (!dres.ok) { docsEl.textContent = 'Documentation not found'; return; }
          const md = await dres.text();
          // Render markdown to HTML using marked and sanitize with DOMPurify
          if (typeof marked !== 'undefined') {
            const html = marked.parse(md);
            const clean = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(html) : html;
            docsEl.innerHTML = clean;
          } else {
            docsEl.innerHTML = '<pre>' + escapeHtml(md) + '</pre>';
          }
        } catch (err){
          docsEl.textContent = 'Error loading doc: ' + err.message;
        }
      }

      function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      load();
    </script>
  </body>
</html>`;

        res.type('html').send(html);
    });

    // Provide the endpoints list as JSON (read from app.locals populated by apis.js)
    app.get('/api/endpoints', (req, res) => {
        res.json(app.locals.apiEndpoints || []);
    });

    // Serve raw markdown docs from the local api_documentation folder
    app.get('/api/docs/:name', (req, res) => {
        const name = req.params.name;
        const docsDir = path.join(__dirname, '..', 'api_documentation');
        const file = path.join(docsDir, `${name}.md`);
        fs.readFile(file, 'utf8', (err, data) => {
            if (err) return res.status(404).send('Not found');
            res.type('text').send(data);
        });
    });
};
