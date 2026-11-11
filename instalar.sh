#!/usr/bin/env bash
# Instalador local do Quadro no Ar (Linux). Tudo fica na sua pasta pessoal; não precisa de senha de administrador.
#
#   ./instalar.sh              instala (ou atualiza: rode de novo depois de mexer no quadro)
#   ./instalar.sh --remover    desinstala (o mesmo que ~/.local/share/quadro-no-ar/desinstalar.sh);
#                              os desenhos e arquivos guardados no navegador continuam lá
#
# O que é instalado:
#   ~/.local/share/quadro-no-ar/         cópia do quadro (lousa.html, servidor.js) e o desinstalador
#   ~/.local/bin/quadro-no-ar            comando que liga o servidor e abre o quadro numa janela própria do navegador
#   menu de aplicativos e área de trabalho   ícone "Quadro no Ar"
#   endereço quadronoar://               deixa o botão Transmitir ligar o servidor sozinho
#
# Precisa do Node 18 ou mais novo. O quadro abre em http://localhost:8080 (com câmera e gestos);
# os outros aparelhos da rede assistem pelo QR Code do botão Transmitir.
set -euo pipefail

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DADOS="${XDG_DATA_HOME:-$HOME/.local/share}"
DESTINO="$DADOS/quadro-no-ar"
BIN="$HOME/.local/bin"
COMANDO="$BIN/quadro-no-ar"
APLICATIVOS="$DADOS/applications"
ATALHO_MENU="$APLICATIVOS/quadro-no-ar.desktop"
ATALHO_SERVIDOR="$APLICATIVOS/quadro-no-ar-servidor.desktop"
ICONE="$DADOS/icons/hicolor/scalable/apps/quadro-no-ar.svg"
AREA="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
ATALHO_AREA="$AREA/quadro-no-ar.desktop"

remover() {
  rm -f "$COMANDO" "$ATALHO_MENU" "$ATALHO_SERVIDOR" "$ICONE" "$ATALHO_AREA"
  rm -rf "$DESTINO"
  MIMEAPPS="${XDG_CONFIG_HOME:-$HOME/.config}/mimeapps.list"
  [[ -f "$MIMEAPPS" ]] && sed -i '/^x-scheme-handler\/quadronoar=/d' "$MIMEAPPS"     # desfaz o registro do quadronoar://
  update-desktop-database "$APLICATIVOS" 2>/dev/null || true
  gtk-update-icon-cache -q "$DADOS/icons/hicolor" 2>/dev/null || true
  echo "Quadro no Ar desinstalado."
  echo "Os arquivos e desenhos guardados no navegador continuam lá; para apagá-los, limpe os dados do site localhost:8080 no navegador."
}

if [[ "${1:-}" == "--remover" || "$(basename "$0")" == "desinstalar.sh" ]]; then remover; exit 0; fi

# ---------- verificações ----------
for arq in lousa.html servidor.js; do
  [[ -f "$ORIGEM/$arq" ]] || { echo "Não encontrei $arq ao lado do instalador ($ORIGEM)." >&2; exit 1; }
done
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "Não encontrei o Node. Instale o Node 18 ou mais novo (https://nodejs.org) e rode ./instalar.sh de novo." >&2
  exit 1
fi
VERSAO="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( VERSAO < 18 )); then
  echo "O Node instalado é a versão $VERSAO; o Quadro no Ar precisa da 18 ou mais nova." >&2
  exit 1
fi

# ---------- cópia do aplicativo ----------
mkdir -p "$DESTINO" "$BIN" "$APLICATIVOS" "$(dirname "$ICONE")"
cp "$ORIGEM/lousa.html" "$ORIGEM/servidor.js" "$DESTINO/"
# cópia das bibliotecas (node aplicativo/baixar-bibliotecas.js): com ela, o quadro funciona sem internet
rm -rf "$DESTINO/bibliotecas"
[[ -d "$ORIGEM/bibliotecas" ]] && cp -r "$ORIGEM/bibliotecas" "$DESTINO/"
cp "$ORIGEM/instalar.sh" "$DESTINO/desinstalar.sh"
chmod +x "$DESTINO/desinstalar.sh"
rm -f "$DADOS/quadro-no-ar/iniciar-servidor.sh"          # lançador da versão anterior do instalador

# ---------- comando quadro-no-ar ----------
# Guarda o caminho completo do Node: o menu de aplicativos não lê o PATH do terminal (nvm, por exemplo)
cat > "$COMANDO" <<EOF
#!/usr/bin/env bash
# Quadro no Ar: liga o servidor (se ainda não estiver ligado) e abre o quadro numa janela do navegador.
#   quadro-no-ar               abre o quadro
#   quadro-no-ar --servidor    só liga o servidor (é o que o botão Transmitir usa, pelo endereço quadronoar://)
# Para escolher o navegador: QUADRO_NAVEGADOR=firefox quadro-no-ar
NODE=$(printf '%q' "$NODE")
APP=$(printf '%q' "$DESTINO")
URL="http://localhost:8080"
LOG="\${XDG_RUNTIME_DIR:-/tmp}/quadro-no-ar-servidor.log"

no_ar() { "\$NODE" -e "fetch('\$URL/servidor').then(r => r.json()).then(j => process.exit(j.quadro ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; }

ligar_servidor() {
  no_ar && return 0
  (cd "\$APP" && setsid nohup "\$NODE" servidor.js --automatico >>"\$LOG" 2>&1 < /dev/null &)
  for _ in \$(seq 1 40); do no_ar && return 0; sleep 0.25; done
  return 1
}

avisar() {
  echo "\$1" >&2
  command -v notify-send >/dev/null && notify-send "Quadro no Ar" "\$1" || true
}

case "\${1:-}" in
  --servidor|quadronoar:*) ligar_servidor; exit \$? ;;
esac

if ! ligar_servidor; then
  avisar "Não consegui ligar o servidor (a porta 8080 pode estar ocupada por outro programa). Detalhes em \$LOG"
  exit 1
fi

# janela própria (modo aplicativo) nos navegadores baseados no Chromium; nos outros, uma aba comum
if [[ -n "\${QUADRO_NAVEGADOR:-}" ]]; then exec \$QUADRO_NAVEGADOR "\$URL"; fi
for nav in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "\$nav" >/dev/null; then exec "\$nav" --app="\$URL" --start-maximized; fi
done
exec xdg-open "\$URL"
EOF
chmod +x "$COMANDO"

# ---------- ícone ----------
cat > "$ICONE" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="8" y="16" width="112" height="80" rx="10" fill="#1f3b2d"/>
  <rect x="14" y="22" width="100" height="68" rx="6" fill="#24503a"/>
  <path d="M28 70 C 40 46, 52 46, 60 60 S 82 76, 98 40" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
  <rect x="26" y="34" width="38" height="9" rx="4" fill="#ffd400" opacity="0.75"/>
  <circle cx="98" cy="40" r="6" fill="#e5202b"/>
  <rect x="54" y="96" width="20" height="14" fill="#1f3b2d"/>
  <rect x="36" y="108" width="56" height="8" rx="4" fill="#1f3b2d"/>
</svg>
EOF

# ---------- atalhos ----------
cat > "$ATALHO_MENU" <<EOF
[Desktop Entry]
Type=Application
Name=Quadro no Ar
Comment=Lousa digital com gestos, slides e PDF, que transmite para os aparelhos da rede
Exec=$COMANDO
Icon=quadro-no-ar
Terminal=false
Categories=Education;Office;Presentation;
Keywords=lousa;quadro;pdf;slides;apresentação;
StartupNotify=true
EOF

cat > "$ATALHO_SERVIDOR" <<EOF
[Desktop Entry]
Type=Application
Name=Quadro no Ar (servidor da rede)
Exec=$COMANDO --servidor %u
Icon=quadro-no-ar
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/quadronoar;
EOF

if [[ -d "$AREA" && "$AREA" != "$HOME" ]]; then
  cp "$ATALHO_MENU" "$ATALHO_AREA"
  chmod +x "$ATALHO_AREA"
  gio set "$ATALHO_AREA" metadata::trusted true 2>/dev/null || true     # o GNOME abre o atalho sem perguntar
fi

xdg-mime default quadro-no-ar-servidor.desktop x-scheme-handler/quadronoar 2>/dev/null || true
update-desktop-database "$APLICATIVOS" 2>/dev/null || true
gtk-update-icon-cache -q "$DADOS/icons/hicolor" 2>/dev/null || true

echo "Quadro no Ar instalado."
echo "  Abra pelo menu de aplicativos ou pelo ícone na área de trabalho (ou rode: quadro-no-ar)."
echo "  Na primeira transmissão, o navegador pergunta se pode abrir o \"xdg-open\": marque \"Sempre permitir\"."
case ":$PATH:" in *":$BIN:"*) ;; *) echo "  Para usar o comando quadro-no-ar no terminal, adicione $BIN ao PATH.";; esac
echo "  Para atualizar, rode ./instalar.sh de novo. Para desinstalar: ./instalar.sh --remover (ou $DESTINO/desinstalar.sh)"
