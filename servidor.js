#!/usr/bin/env node
// Servidor do Quadro no Ar para a rede local.
//
//   node servidor.js            (porta 8080; outra porta: PORTA=9000 node servidor.js)
//
// - Neste computador, abra http://localhost:8080 : é o quadro de quem apresenta (com câmera e gestos).
// - Nos outros aparelhos da mesma rede, abra http://<ip deste computador>:8080 : eles só assistem.
//   Acompanham o arquivo aberto, a página, a rolagem, o zoom e as anotações, sem poder mexer em nada.
//
// Só quem está neste computador (localhost) pode publicar o estado e enviar arquivos; os outros só recebem.
// O quadro aberto por outro endereço deste computador (Live Server, file://...) também transmite: ele fala com
// http://localhost:8080. Depois de rodar ./instalar.sh uma vez, o botão Transmitir do quadro inicia este servidor sozinho.
// Com --automatico (como o aplicativo e o botão o iniciam), o servidor se encerra depois de 1 hora sem o quadro aberto
// neste computador e sem ninguém assistindo.
// Sem dependências: só o Node (versão 18 ou mais nova).

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORTA = Number(process.env.PORTA || process.env.PORT || 8080);
const PASTA = __dirname;
const LIMITE_ARQUIVO = 300 * 1024 * 1024;     // maior arquivo (PDF ou .pptx) que o apresentador pode enviar
const LIMITE_ESTADO = 20 * 1024 * 1024;       // maior mensagem de estado (as anotações podem ser grandes)
const ARQUIVOS_GUARDADOS = 6;                 // arquivos enviados que ficam na memória para quem chegar depois
const AUTOMATICO = process.argv.includes('--automatico');
const OCIOSO_MAXIMO = 60 * 60 * 1000;         // no modo automático: encerra depois disso sem transmissão e sem ninguém assistindo
let ultimaAtividade = Date.now();

const assistindo = new Set();                 // respostas abertas de Server-Sent Events
const ultimo = {};                            // tipo -> { seq, texto }: o último de cada tipo, para quem chega depois
const arquivos = new Map();                   // id -> { nome, tipo, dados }

const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
// Páginas deste computador abertas por outro endereço (Live Server, file://) podem falar com o servidor; sites de fora, não
const origemLocal = o => o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o || '');

function enderecosNaRede() {
  const lista = [];
  for (const placas of Object.values(os.networkInterfaces()))
    for (const p of placas || []) if (p.family === 'IPv4' && !p.internal) lista.push(p.address);
  // primeiro os endereços típicos de Wi-Fi e cabo de casa ou escola; os de máquinas virtuais e Docker (172.x) por último
  const peso = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 3 : 2;
  return lista.sort((a, b) => peso(a) - peso(b)).map(ip => 'http://' + ip + ':' + PORTA);
}

function lerCorpo(req, limite) {
  return new Promise((ok, falha) => {
    const partes = []; let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limite) { falha(Object.assign(new Error('grande demais'), { codigo: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}

function responder(res, codigo, corpo, tipo) {
  res.writeHead(codigo, { 'Content-Type': tipo || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function enviarEvento(res, tipo, texto) { res.write('event: ' + tipo + '\ndata: ' + texto + '\n\n'); }

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' };

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname;
  if (local(req)) ultimaAtividade = Date.now();   // o quadro aberto neste computador mantém o servidor ligado
  const origem = req.headers.origin;
  if (origem && origemLocal(origem) && local(req)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nome');
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204); return res.end();
    }
  } else if (origem && !origemLocal(origem) && req.method !== 'GET') return responder(res, 403, 'origem não aceita');
  try {
    // a página do quadro: para todos
    if (req.method === 'GET' && (rota === '/' || rota === '/index.html')) {
      return responder(res, 200, fs.readFileSync(path.join(PASTA, 'index.html')), TIPOS['.html']);
    }
    // o quadro pergunta se está neste servidor (e se pode apresentar)
    if (req.method === 'GET' && rota === '/servidor') {
      return responder(res, 200, JSON.stringify({ quadro: true, apresentador: local(req), enderecos: enderecosNaRede(), assistindo: assistindo.size }), TIPOS['.json']);
    }
    // quem assiste: fluxo de eventos com o estado do apresentador
    if (req.method === 'GET' && rota === '/eventos') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      for (const tipo of ['estado', 'anotacoes']) if (ultimo[tipo]) enviarEvento(res, tipo, ultimo[tipo].texto);
      assistindo.add(res);
      req.on('close', () => assistindo.delete(res));
      return;
    }
    // arquivo aberto pelo apresentador (PDF ou .pptx), para quem assiste
    if (req.method === 'GET' && rota === '/arquivo') {
      const a = arquivos.get(url.searchParams.get('id') || '');
      if (!a) return responder(res, 404, 'arquivo ainda não enviado');
      res.writeHead(200, { 'Content-Type': a.tipo, 'Cache-Control': 'no-store', 'X-Nome': encodeURIComponent(a.nome) });
      return res.end(a.dados);
    }

    // daqui para baixo, só o apresentador (este computador)
    if (!local(req)) return responder(res, 403, 'Só o computador que roda o servidor pode apresentar.');

    if (req.method === 'POST' && rota === '/publicar') {
      const tipo = url.searchParams.get('tipo'), seq = Number(url.searchParams.get('seq')) || 0;
      if (tipo !== 'estado' && tipo !== 'anotacoes') return responder(res, 400, 'tipo desconhecido');
      const texto = (await lerCorpo(req, LIMITE_ESTADO)).toString('utf8').replace(/\n/g, ' ');
      if (ultimo[tipo] && seq && seq < ultimo[tipo].seq) return responder(res, 200, 'antigo');   // chegou fora de ordem: já há um mais novo
      ultimo[tipo] = { seq, texto }; ultimaAtividade = Date.now();
      for (const r of assistindo) enviarEvento(r, tipo, texto);
      return responder(res, 200, JSON.stringify({ assistindo: assistindo.size }), TIPOS['.json']);
    }
    if (req.method === 'PUT' && rota === '/arquivo') {
      const id = url.searchParams.get('id');
      if (!id) return responder(res, 400, 'falta o id');
      const dados = await lerCorpo(req, LIMITE_ARQUIVO);
      const nome = decodeURIComponent(req.headers['x-nome'] || 'arquivo');
      arquivos.delete(id);
      arquivos.set(id, { nome, tipo: TIPOS[path.extname(nome).toLowerCase()] || 'application/octet-stream', dados });
      while (arquivos.size > ARQUIVOS_GUARDADOS) arquivos.delete(arquivos.keys().next().value);
      return responder(res, 200, 'ok');
    }
    // arquivos da pasta do quadro (o quadro reabre os arquivos guardados pelo caminho): só para o apresentador
    if (req.method === 'GET') {
      const alvo = path.resolve(PASTA, '.' + decodeURIComponent(rota));
      if (!alvo.startsWith(PASTA + path.sep) || alvo.split(path.sep).some(p => p.startsWith('.') && p.length > 1)) return responder(res, 404, 'não encontrado');
      if (!fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) return responder(res, 404, 'não encontrado');
      return responder(res, 200, fs.readFileSync(alvo), TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream');
    }
    responder(res, 405, 'método não aceito');
  } catch (e) {
    if (!res.headersSent) responder(res, e.codigo || 500, e.codigo === 413 ? 'grande demais' : 'erro');
  }
});

// mantém as conexões de quem assiste vivas (alguns roteadores e celulares fecham conexões paradas)
setInterval(() => {
  for (const r of assistindo) r.write(': ping\n\n');
  if (assistindo.size) ultimaAtividade = Date.now();
  if (AUTOMATICO && Date.now() - ultimaAtividade > OCIOSO_MAXIMO) { console.log('Uma hora sem transmissão: encerrando.'); process.exit(0); }
}, 20000);

servidor.listen(PORTA, '0.0.0.0', () => {
  const rede = enderecosNaRede();
  console.log('Quadro no Ar no ar.\n');
  console.log('  Apresentar (neste computador):  http://localhost:' + PORTA);
  if (rede.length) console.log('  Assistir (outros aparelhos):    ' + rede.join('\n                                  '));
  else console.log('  Nenhuma rede encontrada: conecte o computador ao Wi-Fi ou ao cabo para os outros aparelhos assistirem.');
  console.log('\nQuem abre pelo endereço da rede só assiste: não mexe no quadro. Ctrl+C encerra.');
});
servidor.on('error', e => {
  // iniciado pelo botão com o servidor já no ar: não há nada a fazer
  console.error(e.code === 'EADDRINUSE' ? (AUTOMATICO ? 'O servidor já está no ar.' : 'A porta ' + PORTA + ' já está em uso. Tente outra: PORTA=8081 node servidor.js') : e.message);
  process.exit(e.code === 'EADDRINUSE' && AUTOMATICO ? 0 : 1);
});
