// Aplicativo Quadro no Ar (Electron): o quadro numa janela própria, com o servidor da rede embutido.
// Quem instala não precisa de Node, terminal nem configuração: ao abrir o aplicativo, o servidor já está no ar e o botão
// Transmitir mostra o QR Code para os aparelhos do mesmo Wi-Fi. Funciona sem internet.
//
// Em desenvolvimento:  cd aplicativo && npm install && npm start
// Instaladores:        npm run dist:win   (Windows, .exe)   |   npm run dist:linux   (.AppImage e .deb)

'use strict';
const { app, BrowserWindow, session, shell, dialog } = require('electron');
const path = require('path');

// lousa.html e servidor.js: ao lado do aplicativo no instalador (resources/quadro); na pasta de cima em desenvolvimento
const PASTA_QUADRO = app.isPackaged ? path.join(process.resourcesPath, 'quadro') : path.join(__dirname, '..');
const PORTAS = [8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];

let janela = null, porta = null;

// uma janela só: abrir o aplicativo de novo (ou pelo endereço quadronoar://) traz a janela que já está aberta
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!janela) return;
    if (janela.isMinimized()) janela.restore();
    janela.focus();
  });
  app.whenReady().then(abrir);
}
app.setAsDefaultProtocolClient('quadronoar');      // o botão Transmitir do site abre o aplicativo
app.on('window-all-closed', () => app.quit());

async function ligarServidor() {
  const servidor = require(path.join(PASTA_QUADRO, 'servidor.js'));
  for (const p of PORTAS) {
    try { return await servidor.iniciar(p); }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }      // porta ocupada (outro programa): tenta a próxima
  }
  throw new Error('as portas ' + PORTAS[0] + ' a ' + PORTAS[PORTAS.length - 1] + ' estão ocupadas por outros programas');
}

async function abrir() {
  try { porta = await ligarServidor(); }
  catch (e) {
    dialog.showErrorBox('Quadro no Ar', 'Não consegui ligar o servidor da rede: ' + e.message + '.');
    return app.quit();
  }
  const sessao = session.defaultSession;
  const origem = 'http://localhost:' + porta;
  const daqui = url => typeof url === 'string' && url.startsWith(origem);
  // câmera (gestos), microfone (gravação), tela cheia e área de transferência: só para o próprio quadro
  const PERMITIDAS = ['media', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'];
  sessao.setPermissionRequestHandler((wc, permissao, responder, detalhes) => responder(PERMITIDAS.includes(permissao) && daqui(detalhes.requestingUrl || wc.getURL())));
  sessao.setPermissionCheckHandler((wc, permissao, origemPedido) => PERMITIDAS.includes(permissao) && daqui(origemPedido + '/'));
  // botão Gravar: grava a própria janela do quadro (com o som do sistema, onde o sistema permite)
  sessao.setDisplayMediaRequestHandler((pedido, responder) => {
    responder(process.platform === 'win32' ? { video: pedido.frame, audio: 'loopback' } : { video: pedido.frame });
  });

  janela = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 480, show: false,
    title: 'Quadro no Ar', backgroundColor: '#0e1016', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icone.png'),
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  janela.removeMenu();
  janela.once('ready-to-show', () => { janela.maximize(); janela.show(); });
  // links para fora (ajuda, downloads) abrem no navegador do sistema; a janela do quadro não sai do quadro
  janela.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  janela.webContents.on('will-navigate', (e, url) => { if (!daqui(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  janela.on('closed', () => { janela = null; });
  janela.loadURL(origem + '/');
}
