/* ============================================================
   PEDIDOS LAGOA — Service Worker
   ============================================================
   Duas funções, só isso:

   1) Deixa o app INSTALÁVEL. É a presença deste arquivo (mais o
      manifest.webmanifest) que faz o Android/Chrome oferecer
      "Instalar aplicativo" e o iPad aceitar "Adicionar à Tela de
      Início". Instalado, o tablet abre em tela cheia, sem barra
      de endereço — ninguém sai da tela sem querer.

   2) Guarda uma cópia do app ("app shell") para abrir rápido e
      não ficar em branco quando o Wi-Fi da beira da lagoa cair.

   Os DADOS (pedidos, cardápio) NUNCA são guardados aqui: eles
   vêm sempre do Supabase. Um pedido cacheado seria pior que
   pedido nenhum — a recepção acharia que já mandou.

   ⚠ AO PUBLICAR UMA VERSÃO NOVA: mude o número em CACHE abaixo e
     o "?v=" das tags <script>/<link> no index.html. Sem isso os
     tablets podem continuar com a versão antiga por dias.
   ============================================================ */

const CACHE = "pedidos-lagoa-v9";

// As fotos e os vídeos ficam num cache SEPARADO, que NÃO é apagado a cada
// versão nova do app. Se fossem juntos, publicar uma correção de texto
// faria os 17 tablets baixarem os vídeos de novo.
const CACHE_MIDIA = "pedidos-lagoa-midia";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=9",
  "./config.js?v=9",
  "./qr.js?v=9",
  "./app.js?v=9",
  "./quiosque.js?v=9",
  "./propaganda.js?v=9",
  "./recepcao.js?v=9",
  "./admin.js?v=9",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll falha inteiro se UM arquivo faltar. Guardamos um por um
      // para um ícone ausente não impedir a instalação do app.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(
        chaves.filter((k) => k !== CACHE && k !== CACHE_MIDIA).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // As FOTOS e a PROPAGANDA são a exceção: guardamos para sempre.
  // Não é enfeite de velocidade — é dinheiro. Dezessete tablets rebaixando
  // um vídeo a cada laço estouraria a franquia de internet do Supabase em
  // dias. O nome do arquivo é sorteado e nunca se repete, então uma cópia
  // guardada nunca fica "velha": anúncio novo é arquivo novo.
  if (/\/storage\/v1\/object\/public\/(propaganda|cardapio)\//.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE_MIDIA).then((c) =>
        c.match(req).then((achou) => {
          if (achou) return achou;
          return fetch(req).then((res) => {
            if (res && res.status === 200) c.put(req, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // Supabase e qualquer outro servidor: passa direto, sem cache.
  // É dado ao vivo — uma cópia velha aqui viraria pedido fantasma.
  if (url.origin !== self.location.origin || url.hostname.indexOf("supabase") >= 0) return;

  // App shell: REDE PRIMEIRO. Online, sempre pega a versão nova
  // (assim uma correção chega ao tablet na primeira recarga).
  // Offline, cai para a cópia guardada.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((achou) => {
          if (achou) return achou;
          // Recarregou a página sem internet e sem cópia exata da URL:
          // devolve a página inicial em vez do erro do navegador.
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "Sem internet" });
        })
      )
  );
});

// Permite ao app pedir "atualize agora" sem esperar o navegador.
self.addEventListener("message", (e) => {
  if (e.data === "atualizar") self.skipWaiting();
});
