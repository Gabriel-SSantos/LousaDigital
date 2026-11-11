#!/usr/bin/env node
// Servidor do Quadro no Ar. Funciona de dois jeitos:
//
// MODO LOCAL (padrão), na rede da escola ou de casa:
//   node servidor.js            (porta 8080; outra porta: PORTA=9000 node servidor.js)
//
// - Neste computador, abra http://localhost:8080 : é o quadro de quem apresenta (com câmera e gestos).
// - Nos outros aparelhos da mesma rede, abra http://<ip deste computador>:8080 : eles só assistem.
//   Acompanham o arquivo aberto, a página, a rolagem, o zoom e as anotações, sem poder mexer em nada.
// Só quem está neste computador (localhost) pode publicar o estado e enviar arquivos; os outros só recebem.
// O quadro aberto por outro endereço deste computador (Live Server, file://...) também transmite: ele fala com
// http://localhost:8080. Depois de rodar ./instalar.sh uma vez, o botão Transmitir do quadro inicia este servidor sozinho.
// Com --automatico (como o aplicativo e o botão o iniciam), o servidor se encerra depois de 1 hora sem o quadro aberto
// neste computador e sem ninguém assistindo.
//
// MODO WEB, hospedado num domínio (Render, Railway, Fly.io, uma VPS...: precisa de um processo Node sempre ligado;
// GitHub Pages, Vercel e Netlify não servem):
//   node servidor.js --web      (ou QUADRO_WEB=1; a porta vem de PORT, como os serviços de hospedagem definem)
//
// - Quem abre https://<domínio>/ apresenta. Ao clicar em Transmitir, o quadro cria uma sala com um código (ex.: K7M2QX)
//   e recebe uma chave secreta: só quem tem a chave publica naquela sala.
// - Quem abre https://<domínio>/?sala=K7M2QX (o QR Code) assiste àquela sala, de qualquer rede.
// - Cada sala tem o seu estado. Sala sem apresentador por 2 horas e sem ninguém assistindo é apagada.
// - O servidor também apresenta os aparelhos uns aos outros (sinalização WebRTC): depois disso, o quadro, as anotações e os
//   arquivos vão direto do computador de quem apresenta para cada aparelho, pela rede local. Quem não consegue a conexão
//   direta (rede com isolamento entre aparelhos, celular no 4G) continua recebendo tudo por aqui.
// Variáveis opcionais: URL_PUBLICA (endereço público, se o proxy não informar), MAX_SALAS (100),
// LIMITE_ARQUIVO_MB (50 no modo web), TOTAL_ARQUIVOS_MB (1024: memória máxima para os arquivos de todas as salas).
//
// O aplicativo instalável (pasta aplicativo/) roda este mesmo arquivo por dentro: require('./servidor.js').iniciar(porta).
// Sem dependências: só o Node (versão 18 ou mais nova).

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const WEB = process.argv.includes('--web') || process.env.QUADRO_WEB === '1';
const PORTA = Number(process.env.PORTA || process.env.PORT || 8080);
const PASTA = __dirname;
// Cópia das bibliotecas dos CDNs (o aplicativo instalável traz uma, para funcionar sem internet; ver aplicativo/baixar-bibliotecas.js)
const PASTA_BIBLIOTECAS = path.join(PASTA, 'bibliotecas');
const TEM_BIBLIOTECAS = fs.existsSync(PASTA_BIBLIOTECAS);
const MB = 1024 * 1024;
const LIMITE_ARQUIVO = Number(process.env.LIMITE_ARQUIVO_MB || (WEB ? 50 : 300)) * MB;   // maior arquivo (PDF ou .pptx) que o apresentador pode enviar
const LIMITE_ESTADO = (WEB ? 5 : 20) * MB;   // maior mensagem de estado (as anotações podem ser grandes)
const ARQUIVOS_GUARDADOS = WEB ? 3 : 6;      // arquivos enviados que ficam na memória (por sala) para quem chegar depois
const TOTAL_ARQUIVOS = Number(process.env.TOTAL_ARQUIVOS_MB || 1024) * MB;   // modo web: memória para os arquivos de todas as salas
const MAX_SALAS = Number(process.env.MAX_SALAS || 100);
const MAX_PLATEIA = 300;                     // modo web: conexões assistindo por sala
const SALAS_POR_IP = 20;                     // modo web: salas novas por endereço por hora
const SALA_ESQUECIDA = 2 * 60 * 60 * 1000;   // modo web: sala sem apresentador e sem ninguém assistindo por esse tempo é apagada
const URL_PUBLICA = (process.env.URL_PUBLICA || '').replace(/\/+$/, '');
const AUTOMATICO = !WEB && process.argv.includes('--automatico');
const OCIOSO_MAXIMO = 60 * 60 * 1000;        // no modo automático: encerra depois disso sem transmissão e sem ninguém assistindo
let ultimaAtividade = Date.now();
// A sala só existe enquanto o apresentador transmite: ele avisa a cada poucos segundos (e a cada publicação).
// Sem aviso por esse tempo (aba fechada, computador dormindo), a sala acaba: quem assiste sai e o último estado é apagado,
// para ninguém entrar depois numa sala que já não existe.
const SEM_APRESENTADOR = 90 * 1000;           // longo o bastante para a aba do apresentador em segundo plano (o navegador atrasa os timers)
const ENCERRAR_AO_FECHAR = 10 * 1000;         // ao fechar ou recarregar a aba do apresentador: se ele não voltar nesse tempo, a sala acaba

// ----- salas -----
// No modo local há uma sala só (código ''), e quem apresenta é quem está neste computador.
// No modo web, cada apresentador cria a sua, com um código para quem assiste e uma chave (token) só dele.
const LETRAS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sem 0/O, 1/I/L: fácil de ditar e digitar
function novaSala(codigo) {
  return { codigo, token: codigo ? crypto.randomBytes(24).toString('base64url') : '',
    ultimo: {},                 // tipo -> { seq, texto }: o último de cada tipo, para quem chega depois
    arquivos: new Map(),        // id -> { nome, tipo, dados }
    assistindo: new Map(),      // resposta aberta de Server-Sent Events -> { aparelho, nome, desde, conexao, sinais }
    sinais: new Set(),          // fluxos abertos do apresentador para a sinalização WebRTC
    visto: 0, aberta: false, sessao: 0, criada: Date.now() };
}
const salas = new Map();
if (!WEB) salas.set('', novaSala(''));
function criarSala() {
  let codigo;
  do codigo = Array.from(crypto.randomBytes(6), b => LETRAS[b % LETRAS.length]).join(''); while (salas.has(codigo));
  const s = novaSala(codigo); salas.set(codigo, s); return s;
}
const salaAtiva = s => Date.now() - s.visto < SEM_APRESENTADOR;
function marcarApresentador(s) {
  if (!s.aberta) { s.aberta = true; s.sessao++; }     // sala reaberta: o apresentador vê a sessão mudar e publica tudo de novo
  s.visto = Date.now();
}
// o apresentador sabe quem está conectado (para abrir a conexão direta com cada um e saber quem ainda depende do servidor)
const conexoes = s => JSON.stringify([...s.assistindo.values()].map(p => p.conexao));
function avisarConexoes(s) { const t = conexoes(s); for (const r of s.sinais) enviarEvento(r, 'conexoes', t); }
const MAX_SINAIS = 30;                        // mensagens de sinalização por conexão de quem assiste
function encerrarSala(s) {
  s.aberta = false; s.visto = 0; s.ultimo = {};
  for (const r of s.assistindo.keys()) enviarEvento(r, 'encerrada', '{}');
}
function tokenConfere(s, token) {
  const a = Buffer.from(String(token || '')), b = Buffer.from(s.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const bytesGuardados = () => { let t = 0; for (const s of salas.values()) for (const a of s.arquivos.values()) t += a.dados.length; return t; };

const criadasPorIp = new Map();               // ip -> instantes das salas criadas na última hora
function podeCriar(ip) {
  const agora = Date.now(), lista = (criadasPorIp.get(ip) || []).filter(t => agora - t < 60 * 60 * 1000);
  if (lista.length >= SALAS_POR_IP) { criadasPorIp.set(ip, lista); return false; }
  lista.push(agora); criadasPorIp.set(ip, lista); return true;
}

const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const ipDe = req => (WEB && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
// Páginas deste computador abertas por outro endereço (Live Server, file://) podem falar com o servidor; sites de fora, não
const origemLocal = o => o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o || '');
// modo web: só a página do próprio domínio cria salas e publica (atrás de proxy, o domínio público pode vir em X-Forwarded-Host)
const mesmaOrigem = (o, req) => { try { const h = new URL(o).host; return h === req.headers.host || h === req.headers['x-forwarded-host']; } catch (e) { return false; } };
function enderecoPublico(req) {
  if (URL_PUBLICA) return URL_PUBLICA;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
}

// nome que quem assiste digitou: sem caracteres de controle, espaços juntados, no máximo 40 caracteres
const limparNome = n => String(n || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
// quem assiste, um por aparelho (a mesma pessoa com duas abas, ou reconectando, conta uma vez só)
function plateia(s) {
  const porAparelho = new Map();
  for (const p of s.assistindo.values()) {
    const ja = porAparelho.get(p.aparelho);
    if (!ja) porAparelho.set(p.aparelho, { ...p });
    else { ja.desde = Math.min(ja.desde, p.desde); if (p.nome) ja.nome = p.nome; }
  }
  return [...porAparelho.values()].sort((a, b) => a.desde - b.desde);
}

function enderecosNaRede() {
  const lista = [];
  for (const placas of Object.values(os.networkInterfaces()))
    for (const p of placas || []) if (p.family === 'IPv4' && !p.internal) lista.push(p.address);
  // primeiro os endereços típicos de Wi-Fi e cabo de casa ou escola; os de máquinas virtuais e Docker (172.x) por último
  const peso = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 3 : 2;
  const porta = (servidor.address() && servidor.address().port) || PORTA;
  return lista.sort((a, b) => peso(a) - peso(b)).map(ip => 'http://' + ip + ':' + porta);
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
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' };

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname;
  if (!WEB && local(req)) ultimaAtividade = Date.now();   // o quadro aberto neste computador mantém o servidor ligado
  const origem = req.headers.origin;
  if (!WEB && origem && origemLocal(origem) && local(req)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nome');
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204); return res.end();
    }
  } else if (origem && req.method !== 'GET' && !(WEB ? mesmaOrigem(origem, req) : origemLocal(origem))) return responder(res, 403, 'origem não aceita');

  // a sala do pedido (?sala=CÓDIGO no modo web) e se quem pede é o apresentador dela (?token= no modo web; localhost no local)
  const sala = salas.get(WEB ? String(url.searchParams.get('sala') || '').toUpperCase() : '');
  const apresentador = !!sala && (WEB ? tokenConfere(sala, url.searchParams.get('token')) : local(req));
  try {
    // a página do quadro: para todos
    if (req.method === 'GET' && (rota === '/' || rota === '/index.html')) {
      let pagina = fs.readFileSync(path.join(PASTA, 'index.html'), 'utf8');
      if (TEM_BIBLIOTECAS) pagina = pagina.replace('<head>', '<head><script>window.QUADRO_BIBLIOTECAS = true</script>');   // a página usa a cópia local
      return responder(res, 200, pagina, TIPOS['.html']);
    }
    // a cópia local das bibliotecas: para todos (quem assiste também precisa do leitor de PDF e de .pptx)
    if (req.method === 'GET' && TEM_BIBLIOTECAS && rota.startsWith('/bibliotecas/')) {
      const alvo = path.resolve(PASTA_BIBLIOTECAS, '.' + decodeURIComponent(rota.slice('/bibliotecas'.length)));
      if (!alvo.startsWith(PASTA_BIBLIOTECAS + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) return responder(res, 404, 'não encontrado');
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(alvo).pipe(res);
    }
    // modo web: o quadro cria uma sala ao começar a transmitir e recebe o código e a chave dela
    if (WEB && req.method === 'POST' && rota === '/salas') {
      if (salas.size >= MAX_SALAS) return responder(res, 503, 'Muitas salas abertas neste servidor agora. Tente de novo mais tarde.');
      if (!podeCriar(ipDe(req))) return responder(res, 429, 'Muitas salas criadas deste endereço na última hora.');
      const s = criarSala();
      return responder(res, 200, JSON.stringify({ codigo: s.codigo, token: s.token }), TIPOS['.json']);
    }
    // o quadro pergunta se está neste servidor, se pode apresentar e se a sala está no ar.
    // ?transmitindo=1 (do apresentador) é o aviso periódico de que a sala continua aberta
    if (req.method === 'GET' && rota === '/servidor') {
      if (!sala) return responder(res, 200, JSON.stringify({ quadro: true, web: WEB, existe: false, sala: false, apresentador: false, enderecos: [] }), TIPOS['.json']);
      if (apresentador && url.searchParams.get('transmitindo') === '1') marcarApresentador(sala);
      const enderecos = WEB ? (apresentador ? [enderecoPublico(req) + '/?sala=' + sala.codigo] : []) : enderecosNaRede();
      return responder(res, 200, JSON.stringify({ quadro: true, web: WEB, existe: true, codigo: sala.codigo, apresentador, enderecos,
        assistindo: plateia(sala).length, sala: salaAtiva(sala), sessao: sala.sessao,
        // os nomes de quem assiste e os arquivos guardados só vão para quem apresenta
        ...(apresentador ? { plateia: plateia(sala).map(p => ({ id: p.aparelho, nome: p.nome, desde: p.desde })), arquivos: [...sala.arquivos.keys()] } : {}) }), TIPOS['.json']);
    }
    // quem assiste: fluxo de eventos com o estado do apresentador
    if (req.method === 'GET' && rota === '/eventos') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      // sala que não existe, ou ninguém apresentando: não há sala para entrar
      if (!sala || (WEB && sala.assistindo.size >= MAX_PLATEIA)) { enviarEvento(res, 'encerrada', '{}'); return res.end(); }
      if (!salaAtiva(sala)) enviarEvento(res, 'encerrada', '{}');
      else for (const tipo of ['estado', 'anotacoes']) if (sala.ultimo[tipo]) enviarEvento(res, tipo, sala.ultimo[tipo].texto);
      const aparelho = String(url.searchParams.get('aparelho') || '').slice(0, 64) || ('anonimo-' + Math.random().toString(36).slice(2));
      const conexao = crypto.randomBytes(12).toString('base64url');      // identifica esta conexão na sinalização WebRTC
      sala.assistindo.set(res, { aparelho, nome: limparNome(url.searchParams.get('nome')), desde: Date.now(), conexao, sinais: 0 });
      enviarEvento(res, 'ola', JSON.stringify({ id: conexao }));
      avisarConexoes(sala);
      req.on('close', () => { sala.assistindo.delete(res); avisarConexoes(sala); });
      return;
    }
    // sinalização WebRTC, de quem assiste para o apresentador (?de= é a conexão de quem manda)
    if (req.method === 'POST' && rota === '/sinal' && url.searchParams.has('de')) {
      const de = url.searchParams.get('de');
      const quem = sala && [...sala.assistindo.values()].find(p => p.conexao === de);
      if (!quem || ++quem.sinais > MAX_SINAIS) return responder(res, 404, 'conexão desconhecida');
      const d = JSON.parse((await lerCorpo(req, 64 * 1024)).toString('utf8'));
      for (const r of sala.sinais) enviarEvento(r, 'sinal', JSON.stringify({ de, d }));
      return responder(res, 200, sala.sinais.size ? 'ok' : 'sem apresentador');
    }
    // arquivo aberto pelo apresentador (PDF ou .pptx), para quem assiste
    if (req.method === 'GET' && rota === '/arquivo') {
      const a = sala && sala.arquivos.get(url.searchParams.get('id') || '');
      if (!a) return responder(res, 404, 'arquivo ainda não enviado');
      res.writeHead(200, { 'Content-Type': a.tipo, 'Cache-Control': 'no-store', 'X-Nome': encodeURIComponent(a.nome) });
      return res.end(a.dados);
    }

    // daqui para baixo, só o apresentador da sala (modo local: este computador)
    if (!apresentador) {
      if (req.method === 'GET' && WEB) return responder(res, 404, 'não encontrado');
      return responder(res, 403, WEB ? 'Sala inexistente ou chave errada.' : 'Só o computador que roda o servidor pode apresentar.');
    }

    // apresentador: fluxo da sinalização WebRTC (quem está conectado e as mensagens de cada um)
    if (req.method === 'GET' && rota === '/sinais') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      sala.sinais.add(res);
      enviarEvento(res, 'conexoes', conexoes(sala));
      req.on('close', () => sala.sinais.delete(res));
      return;
    }
    // sinalização WebRTC, do apresentador para uma conexão de quem assiste
    if (req.method === 'POST' && rota === '/sinal') {
      const para = url.searchParams.get('para');
      const alvo = [...sala.assistindo].find(([, p]) => p.conexao === para);
      if (!alvo) return responder(res, 404, 'conexão desconhecida');
      const d = JSON.parse((await lerCorpo(req, 64 * 1024)).toString('utf8'));
      enviarEvento(alvo[0], 'sinal', JSON.stringify(d));
      return responder(res, 200, 'ok');
    }
    if (req.method === 'POST' && rota === '/publicar') {
      const tipo = url.searchParams.get('tipo'), seq = Number(url.searchParams.get('seq')) || 0;
      if (tipo !== 'estado' && tipo !== 'anotacoes') return responder(res, 400, 'tipo desconhecido');
      const texto = (await lerCorpo(req, LIMITE_ESTADO)).toString('utf8').replace(/\n/g, ' ');
      marcarApresentador(sala);
      const ultimo = sala.ultimo;
      if (ultimo[tipo] && seq && seq < ultimo[tipo].seq) return responder(res, 200, 'antigo');   // chegou fora de ordem: já há um mais novo
      ultimo[tipo] = { seq, texto }; ultimaAtividade = Date.now();
      for (const r of sala.assistindo.keys()) enviarEvento(r, tipo, texto);
      return responder(res, 200, JSON.stringify({ assistindo: plateia(sala).length }), TIPOS['.json']);
    }
    // a aba do apresentador foi fechada ou recarregada: a sala acaba em poucos segundos, a menos que ele volte a transmitir
    if (req.method === 'POST' && rota === '/encerrar') {
      if (sala.aberta) sala.visto = Math.min(sala.visto, Date.now() - SEM_APRESENTADOR + ENCERRAR_AO_FECHAR);
      return responder(res, 200, 'ok');
    }
    if (req.method === 'PUT' && rota === '/arquivo') {
      const id = url.searchParams.get('id');
      if (!id) return responder(res, 400, 'falta o id');
      const tamanho = Number(req.headers['content-length']) || 0;
      if (WEB && bytesGuardados() + tamanho > TOTAL_ARQUIVOS) return responder(res, 507, 'servidor sem espaço para arquivos agora');
      const dados = await lerCorpo(req, LIMITE_ARQUIVO);
      const nome = decodeURIComponent(req.headers['x-nome'] || 'arquivo');
      sala.arquivos.delete(id);
      sala.arquivos.set(id, { nome, tipo: TIPOS[path.extname(nome).toLowerCase()] || 'application/octet-stream', dados });
      while (sala.arquivos.size > ARQUIVOS_GUARDADOS) sala.arquivos.delete(sala.arquivos.keys().next().value);
      marcarApresentador(sala);
      return responder(res, 200, 'ok');
    }
    // arquivos da pasta do quadro (o quadro reabre os arquivos guardados pelo caminho): só no modo local, para o apresentador
    if (req.method === 'GET' && !WEB) {
      const alvo = path.resolve(PASTA, '.' + decodeURIComponent(rota));
      if (!alvo.startsWith(PASTA + path.sep) || alvo.split(path.sep).some(p => p.startsWith('.') && p.length > 1)) return responder(res, 404, 'não encontrado');
      if (!fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) return responder(res, 404, 'não encontrado');
      return responder(res, 200, fs.readFileSync(alvo), TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream');
    }
    responder(res, req.method === 'GET' ? 404 : 405, req.method === 'GET' ? 'não encontrado' : 'método não aceito');
  } catch (e) {
    if (!res.headersSent) responder(res, e.codigo || (e instanceof SyntaxError ? 400 : 500), e.codigo === 413 ? 'grande demais' : 'erro');
  }
});

// mantém as conexões de quem assiste vivas (alguns roteadores, proxies e celulares fecham conexões paradas)
setInterval(() => {
  let alguem = false;
  for (const s of salas.values()) {
    for (const r of s.assistindo.keys()) { r.write(': ping\n\n'); alguem = true; }
    for (const r of s.sinais) r.write(': ping\n\n');
  }
  if (alguem) ultimaAtividade = Date.now();
  if (AUTOMATICO && Date.now() - ultimaAtividade > OCIOSO_MAXIMO) { console.log('Uma hora sem transmissão: encerrando.'); process.exit(0); }
}, 20000);
setInterval(() => {
  const agora = Date.now();
  for (const [codigo, s] of salas) {
    if (s.aberta && !salaAtiva(s)) encerrarSala(s);
    // modo web: sala esquecida (sem apresentador e sem ninguém assistindo há muito tempo) some, com os arquivos
    if (WEB && !s.aberta && !s.assistindo.size && agora - Math.max(s.visto, s.criada) > SALA_ESQUECIDA) salas.delete(codigo);
  }
}, 2000);

function mostrarEnderecos() {
  if (WEB) {
    console.log('Quadro no Ar no ar (modo web), porta ' + PORTA + '.\n');
    console.log('  Apresentar:  https://<seu domínio>/   (o botão Transmitir cria uma sala)');
    console.log('  Assistir:    https://<seu domínio>/?sala=CÓDIGO   (o QR Code do apresentador)');
    return;
  }
  const rede = enderecosNaRede(), porta = servidor.address().port;
  console.log('Quadro no Ar no ar.\n');
  console.log('  Apresentar (neste computador):  http://localhost:' + porta);
  if (rede.length) console.log('  Assistir (outros aparelhos):    ' + rede.join('\n                                  '));
  else console.log('  Nenhuma rede encontrada: conecte o computador ao Wi-Fi ou ao cabo para os outros aparelhos assistirem.');
  console.log('\nQuem abre pelo endereço da rede só assiste: não mexe no quadro. Ctrl+C encerra.');
}
// liga o servidor na porta pedida; devolve a porta (rejeita com o erro, ex.: EADDRINUSE, para quem chamou tentar outra)
function iniciar(porta = PORTA) {
  return new Promise((ok, falha) => {
    const erro = e => { servidor.off('listening', pronto); falha(e); };
    const pronto = () => { servidor.off('error', erro); ok(servidor.address().port); };
    servidor.once('error', erro); servidor.once('listening', pronto);
    servidor.listen(porta, '0.0.0.0');
  });
}

if (require.main === module) {
  iniciar().then(mostrarEnderecos).catch(e => {
    // iniciado pelo botão com o servidor já no ar: não há nada a fazer
    console.error(e.code === 'EADDRINUSE' ? (AUTOMATICO ? 'O servidor já está no ar.' : 'A porta ' + PORTA + ' já está em uso. Tente outra: PORTA=8081 node servidor.js') : e.message);
    process.exit(e.code === 'EADDRINUSE' && AUTOMATICO ? 0 : 1);
  });
} else module.exports = { iniciar, enderecosNaRede, servidor };
