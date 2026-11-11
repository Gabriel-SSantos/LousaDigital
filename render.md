# Hospedar o servidor no modo web (Render)

O jeito mais simples de hospedar é o **Render**. Ele tem plano gratuito, gera HTTPS sozinho (necessário para a câmera) e mantém o processo Node ligado. O repositório já está pronto para ele: o `package.json` da raiz tem `npm start`, que roda `node servidor.js --web`.

## Passo a passo no Render

1. **Envie as mudanças para o GitHub** (commit e push), porque o Render lê o código de lá.
2. Crie uma conta em [render.com](https://render.com) e entre com o GitHub.
3. Clique em **New → Web Service** e escolha o repositório **LousaDigital**.
4. Preencha os campos:
   - **Language/Runtime:** Node
   - **Branch:** main
   - **Build Command:** `npm install` (não há dependências, então é instantâneo)
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Em **Environment Variables**, adicione:
   - `TOTAL_ARQUIVOS_MB` = `200`. O plano gratuito tem 512 MB de memória, e o padrão do servidor (1 GB para os arquivos de todas as salas) passaria disso.
   - `NODE_VERSION` = `22` (opcional; garante uma versão nova).
6. Em **Advanced → Health Check Path**, coloque `/servidor`.
7. Clique em **Create Web Service**. Em 1–2 minutos ele fica no ar num endereço como `https://lousadigital.onrender.com`.

A porta não precisa de configuração: o Render define `PORT` e o servidor já usa essa variável. O domínio do QR Code também vem certo, porque o servidor lê o endereço público que o Render informa.

### Outras variáveis (opcionais)

| Variável | Padrão | Para que serve |
|---|---|---|
| `TOTAL_ARQUIVOS_MB` | 1024 | Memória máxima para os arquivos de todas as salas juntas |
| `LIMITE_ARQUIVO_MB` | 50 | Maior arquivo (PDF ou .pptx) que passa pelo servidor. Os maiores só vão pela conexão direta |
| `MAX_SALAS` | 100 | Quantas salas podem ficar abertas ao mesmo tempo |
| `URL_PUBLICA` | — | Endereço público, se o QR Code sair com o domínio errado (ex.: `https://quadro.minhaescola.com.br`) |

## Como usar depois

- O professor abre `https://seu-app.onrender.com/` e clica em **Transmitir**. Isso cria a sala e mostra o QR Code.
- Os alunos leem o QR Code (`.../?sala=K7M2QX`) ou digitam o código em "Assistir uma sala".
- Com todos no mesmo Wi-Fi, o selo do aluno mostra "conexão direta", e os dados correm pela rede local. Quem não consegue a conexão direta recebe tudo pelo servidor.

## Limites do plano gratuito

- **Ele "dorme" depois de 15 min sem acesso.** O primeiro acesso depois disso demora cerca de 1 minuto. Durante a aula não dorme, porque o quadro avisa o servidor a cada 4 s.
- **Reiniciar apaga as salas**, porque tudo fica na memória. Se acontecer no meio da aula, o apresentador vê o aviso e abre outra sala, que tem outro QR Code.
- O plano pago mais barato (~US$ 7/mês) não dorme. Vale a pena se a escola usar todo dia.

## O endereço do GitHub Pages

A lousa em `gabriel-ssantos.github.io/LousaDigital/lousa.html` (aberta pelo site de apresentação, em `gabriel-ssantos.github.io/LousaDigital/`) continua existindo, mas lá o Transmitir só oferece o aplicativo, porque o GitHub Pages não roda o servidor. Para os professores usarem a versão com salas, divulgue o endereço do Render.

## Alternativa: servidor próprio (VPS)

Se preferir não depender do Render, uma VPS de ~US$ 5/mês (Hetzner, DigitalOcean…) funciona assim:

1. Instale o Node (18 ou mais novo).
2. Rode `node servidor.js --web` como serviço `systemd`, com `PORT=3000`.
3. Coloque o **Caddy** na frente (`reverse_proxy localhost:3000`). Ele gera o HTTPS sozinho para o seu domínio.

Não dorme e não tem limite de memória do plano gratuito, mas você cuida das atualizações.
