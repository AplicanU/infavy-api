#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const swaggerJSDoc = require('swagger-jsdoc');
const converter = require('openapi-to-postmanv2');
const fetch = globalThis.fetch || require('node-fetch');

const outDir = path.resolve(process.cwd(), 'build');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: process.env.npm_package_name || 'API', version: process.env.npm_package_version || '1.0.0' }
  },
  apis: ['src/routes/**/*.js']
});

// If swagger-jsdoc didn't discover any paths, try to auto-discover routes
function convertColonParamsToBraces(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function buildPathsFromApp() {
  try {
    // require app (will attach routes via attachApis but not start server)
    const app = require('../src/app');
    const endpoints = (app.locals && app.locals.apiEndpoints) || [];
    const paths = {};
    endpoints.forEach((ep) => {
      const raw = ep.url || ep.path || '/';
      const method = (ep.method || 'GET').toLowerCase();
      const path = convertColonParamsToBraces(raw);
      const tag = ep.doc || null;

      // ensure path object
      paths[path] = paths[path] || {};

      // detect path params
      const params = [];
      const paramRegex = /{([A-Za-z0-9_]+)}/g;
      let m;
      while ((m = paramRegex.exec(path)) !== null) {
        params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
      }

      paths[path][method] = {
        summary: `${(ep.method || 'GET').toUpperCase()} ${path}`,
        tags: tag ? [tag] : undefined,
        parameters: params.length ? params : undefined,
        responses: {
          '200': { description: 'OK' }
        }
      };
    });
    return paths;
  } catch (e) {
    // if requiring the app fails, skip autodiscovery
    console.warn('Auto-discovery of routes failed:', e && e.message ? e.message : e);
    return {};
  }
}

const autoPaths = buildPathsFromApp();
if (Object.keys(swaggerSpec.paths || {}).length === 0 && Object.keys(autoPaths).length > 0) {
  swaggerSpec.paths = autoPaths;
}

fs.writeFileSync(path.join(outDir, 'openapi.json'), JSON.stringify(swaggerSpec, null, 2));
console.log('Wrote build/openapi.json');

// Enhance paths by scanning route files for req.query, req.body, req.params to populate parameters/requestBody
function enrichPathsWithSourceInfo(spec) {
  const routesDir = path.resolve(process.cwd(), 'src', 'routes');
  if (!fs.existsSync(routesDir)) return spec;

  // Build mount map from src/apis.js: varName -> mountPath
  const apisPath = path.resolve(process.cwd(), 'src', 'apis.js');
  let mountMap = {};
  try {
    const apisSrc = fs.readFileSync(apisPath, 'utf8');
    // find require lines: const usersRouter = require('./routes/users');
    const requireRegex = /const\s+(\w+)\s*=\s*require\(['"](\.\/routes\/[\w\-\/]+)['"]\);?/g;
    const requires = {};
    let m;
    while ((m = requireRegex.exec(apisSrc)) !== null) {
      requires[m[1]] = m[2];
    }
    // find addRoutesFromRouter calls: addRoutesFromRouter(app, `${routePrefix}/users`, usersRouter, 'AUTH_API');
    const addRegex = /addRoutesFromRouter\(app,\s*([^,]+),\s*(\w+),/g;
    while ((m = addRegex.exec(apisSrc)) !== null) {
      const rawPath = m[1].trim();
      const varName = m[2];
      // resolve template using default routePrefix '/api/v1'
      let resolved = rawPath.replace(/`/g, '').replace(/\$\{routePrefix\}/g, '/api/v1');
      // strip quotes
      resolved = resolved.replace(/^['"]|['"]$/g, '');
      mountMap[varName] = resolved;
    }
  } catch (e) {
    // ignore
  }

  // helper to collect param names from source text
  function collectParamsFromSrc(src) {
    const queryParams = new Set();
    const bodyProps = new Set();
    const paramProps = new Set();
    const requiredBody = new Set();

    // req.query.x or req.query['x']
    const qRegex = /req\.query\.([A-Za-z0-9_]+)|req\.query\[['\"]([A-Za-z0-9_]+)['\"]\]/g;
    let mm;
    while ((mm = qRegex.exec(src)) !== null) {
      queryParams.add(mm[1] || mm[2]);
    }

    // req.params.x
    const pRegex = /req\.params\.([A-Za-z0-9_]+)|req\.params\[['\"]([A-Za-z0-9_]+)['\"]\]/g;
    while ((mm = pRegex.exec(src)) !== null) {
      paramProps.add(mm[1] || mm[2]);
    }

    // req.body.x or payload.x or const { x } = req.body
    const bRegex = /req\.body\.([A-Za-z0-9_]+)|req\.body\[['\"]([A-Za-z0-9_]+)['\"]\]/g;
    while ((mm = bRegex.exec(src)) !== null) {
      bodyProps.add(mm[1] || mm[2]);
    }
    const destructRegex = /\{\s*([A-Za-z0-9_,\s]+)\s*\}\s*=\s*req\.body/g;
    if ((mm = destructRegex.exec(src)) !== null) {
      const list = mm[1].split(',').map(s => s.trim().replace(/[,\s]+/g, ''));
      list.forEach((name) => { if (name) bodyProps.add(name); });
    }

    // detect required checks for body like if (!payload.name) or if (!name) return res.status(400)
    const reqCheckRegex = /if\s*\(\s*(!|typeof)\s*(?:req\.body\.)?([A-Za-z0-9_]+)\s*(?:===|==|!)?\s*\)?\s*\{/g;
    while ((mm = reqCheckRegex.exec(src)) !== null) {
      const name = mm[2];
      if (name) requiredBody.add(name);
    }

    return { queryParams: Array.from(queryParams), bodyProps: Array.from(bodyProps), paramProps: Array.from(paramProps), requiredBody: Array.from(requiredBody) };
  }

  // Walk route files
  const walk = (dir) => {
    const files = fs.readdirSync(dir);
    files.forEach((f) => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) return walk(fp);
      if (!f.endsWith('.js')) return;
      const src = fs.readFileSync(fp, 'utf8');

      // find router.VERB('path', ...)
      const routeRegex = /router\.(get|post|put|delete)\(\s*(['"`])([^'"`]+)\2/g;
      let rm;
      while ((rm = routeRegex.exec(src)) !== null) {
        const method = rm[1].toLowerCase();
        const routePath = rm[3];
        // determine mount path from filename and apis mapping
        // derive varName by filename base
        const rel = path.relative(path.resolve(process.cwd(), 'src'), fp).replace(/\\/g, '/');
        // e.g., routes/users.js or routes/home/hero.js
        const routeModule = './' + rel.replace(/\.js$/, '');

        // find matching varName in mountMap where requires[varName] === routeModule
        let mountBase = '';
        try {
          // reuse requires mapping by scanning apis.js again quickly
          const apisSrc = fs.readFileSync(apisPath, 'utf8');
          const rr = new RegExp("const\\s+(\\w+)\\s*=\\s*require\\(['\"]" + routeModule.replace(/\//g, '\\/') + "['\"]\\)");
          const mm = apisSrc.match(rr);
          if (mm && mm[1] && mountMap[mm[1]]) mountBase = mountMap[mm[1]];
        } catch (e) {
          mountBase = '';
        }

        const fullPath = (mountBase + '/' + routePath).replace(/\/+/g, '/');
        const converted = convertColonParamsToBraces(fullPath);

        const info = collectParamsFromSrc(src);

        // ensure path exists
        spec.paths = spec.paths || {};
        spec.paths[converted] = spec.paths[converted] || {};

        // insert parameter info
        const entry = spec.paths[converted][method] = spec.paths[converted][method] || { responses: { '200': { description: 'OK' } } };

        // add path params from {param}
        const pathParamNames = [];
        const rp = /{([A-Za-z0-9_]+)}/g; let pmm;
        while ((pmm = rp.exec(converted)) !== null) pathParamNames.push(pmm[1]);
        const params = (entry.parameters || []).slice();
        pathParamNames.forEach((pn) => {
          if (!params.some(x => x.name === pn && x.in === 'path')) params.push({ name: pn, in: 'path', required: true, schema: { type: 'string' } });
        });

        // query params
        info.queryParams.forEach((q) => {
          if (!params.some(x => x.name === q && x.in === 'query')) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
        });

        entry.parameters = params.length ? params : undefined;

        // requestBody from bodyProps
        if (info.bodyProps.length) {
          const props = {};
          info.bodyProps.forEach((b) => { props[b] = { type: 'string' }; });
          entry.requestBody = {
            content: {
              'application/json': {
                schema: { type: 'object', properties: props, required: info.requiredBody.length ? info.requiredBody : undefined }
              }
            }
          };
        }
      }
    });
  };

  walk(routesDir);
  return spec;
}

swaggerSpec = enrichPathsWithSourceInfo(swaggerSpec);
fs.writeFileSync(path.join(outDir, 'openapi.json'), JSON.stringify(swaggerSpec, null, 2));
console.log('Wrote enhanced build/openapi.json with inferred params');

converter.convert({ type: 'json', data: swaggerSpec }, {}, async (err, result) => {
  if (err) {
    console.error('Conversion error', err);
    process.exit(1);
  }
  if (!result || !result.result || !result.output || !result.output.length) {
    console.error('Conversion produced no output');
    process.exit(1);
  }
  const collection = result.output[0].data;
  fs.writeFileSync(path.join(outDir, 'postman_collection.json'), JSON.stringify(collection, null, 2));
  console.log('Wrote build/postman_collection.json');

  const apiKey = process.env.POSTMAN_API_KEY;
  const collectionUid = process.env.POSTMAN_COLLECTION_UID;

  if (!apiKey) {
    console.log('POSTMAN_API_KEY not set — collection written locally only at build/postman_collection.json');
    return;
  }

  const payload = { collection };

  try {
    let res;
    if (collectionUid) {
      res = await fetch(`https://api.getpostman.com/collections/${collectionUid}`, {
        method: 'PUT',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('https://api.getpostman.com/collections', {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    const data = await res.json();
    if (!res.ok) {
      console.error('Postman API error', res.status, data);
      process.exit(1);
    }
    const uid = collectionUid || (data.collection && (data.collection.uid || data.collection.id));
    console.log('Postman collection updated. UID:', uid);
  } catch (e) {
    console.error('Failed to push to Postman', e);
    process.exit(1);
  }
});

