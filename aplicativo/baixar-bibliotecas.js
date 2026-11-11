#!/usr/bin/env node
// Baixa uma cópia das bibliotecas que o quadro carrega dos CDNs (leitor de PDF, .pptx, QR Code, rastreador de mãos) para a
// pasta bibliotecas/, ao lado da lousa.html. O aplicativo instalável leva essa pasta junto, e o servidor a serve no lugar
// dos CDNs: assim o quadro funciona sem internet, só com o Wi-Fi da sala.
//
// A lista sai da própria lousa.html (tudo o que passa por biblioteca('https://...')), então não precisa ser mantida à mão.
//   node aplicativo/baixar-bibliotecas.js        (os scripts dist:* do aplicativo já rodam isto)

'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'bibliotecas');
// o rastreador de mãos pede estes arquivos de dentro da pasta wasm (com e sem SIMD, conforme o aparelho)
const ARQUIVOS_WASM = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'];

async function main() {
  const html = fs.readFileSync(path.join(RAIZ, 'lousa.html'), 'utf8');
  const urls = new Set();
  for (const m of html.matchAll(/biblioteca\(\s*(['"])(https:\/\/[^'"]+)\1\s*\)/g)) {
    if (m[2].endsWith('/wasm')) for (const a of ARQUIVOS_WASM) urls.add(m[2] + '/' + a);
    else urls.add(m[2]);
  }
  if (!urls.size) throw new Error('não achei nenhuma biblioteca na lousa.html');
  for (const url of urls) {
    const alvo = path.join(DESTINO, url.replace(/^https:\/\//, ''));
    if (fs.existsSync(alvo) && fs.statSync(alvo).size > 0) { console.log('já tenho  ' + url); continue; }
    const r = await fetch(url);
    if (!r.ok) throw new Error('não consegui baixar ' + url + ' (' + r.status + ')');
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, Buffer.from(await r.arrayBuffer()));
    console.log('baixei    ' + url);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
