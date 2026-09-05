/* ============================================================
   PEDIDOS LAGOA — PROPAGANDA (descanso de tela do tablet)
   ============================================================
   O tablet do quiosque fica ligado o dia inteiro. Passados alguns
   minutos sem ninguém encostar, ele cobre a tela com propaganda
   em laço. Um toque volta EXATAMENTE para onde a pessoa estava —
   inclusive com o carrinho do jeito que ficou, porque a tela de
   trás nunca é desmontada: a propaganda só deita por cima dela.

   POR QUE SÓ NO QUIOSQUE
   Na recepção seria um desastre: ela precisa ver o pedido chegar.
   No celular do cliente seria abuso — é a bateria dele.

   POR QUE O VÍDEO É MUDO
   Não é escolha de gosto: navegador nenhum deixa um vídeo começar
   sozinho com som. Se tivesse áudio, ele simplesmente não tocaria.
   E som repetindo o dia inteiro na beira da lagoa cansaria todo
   mundo antes do meio-dia.
   ============================================================ */
(function () {
  "use strict";

  var PL = window.PL;

  // Quanto tempo uma imagem fica na tela quando o cadastro não disse.
  var SEGUNDOS_PADRAO = 8;

  // Vídeo que não COMEÇA em alguns segundos não vai começar: arquivo
  // corrompido, formato que o aparelho não entende, ou a primeira carga
  // sem internet. Sem este limite a tela ficaria preta esperando.
  var ESPERA_PARA_COMECAR_S = 8;

  // E vídeo que começou mas nunca termina (arquivo com duração quebrada)
  // também não pode segurar o laço para sempre.
  var TETO_DO_VIDEO_S = 180;

  var ligado = false;        // a propaganda está na tela agora?
  var relogioOcioso = null;
  var relogioItem = null;
  var indice = 0;
  var geracao = 0;          // numero do item que esta tocando agora
  var caixa = null;          // o elemento que cobre a tela
  var ultimoToque = Date.now();

  // ==================================================================
  //  O QUE VAI TOCAR
  // ==================================================================
  function lista() {
    return (PL.catalogo.propagandas || [])
      .filter(function (a) { return a.active !== false && a.url; })
      .slice()
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }

  function segundosOciosos() {
    var c = (PL.ctx && PL.ctx.cliente) || {};
    var v = c.ads_idle_seconds;
    if (v === null || v === undefined || v === "") v = PL.CFG.propagandaAposSegundos;
    v = Number(v);
    // 0 é válido e quer dizer "nunca entra"
    return isFinite(v) && v >= 0 ? v : 120;
  }

  function podeMostrar() {
    var c = (PL.ctx && PL.ctx.cliente) || {};
    if (c.ads_enabled === false) return false;
    if (PL.CFG.propagandaLigada === false) return false;
    // só no tablet do quiosque — nunca na recepção, nunca no celular
    // do cliente que veio pelo QR
    if (!PL.ehQuiosque() || PL.ehPublico()) return false;
    if (!segundosOciosos()) return false;
    return lista().length > 0;
  }

  // ==================================================================
  //  O RELÓGIO DA OCIOSIDADE
  // ==================================================================
  function acordou() {
    ultimoToque = Date.now();
    if (ligado) esconder();
    armar();
  }

  function armar() {
    clearTimeout(relogioOcioso);
    if (!podeMostrar()) return;
    relogioOcioso = setTimeout(function () {
      // confere de novo na hora de entrar: o cadastro pode ter mudado,
      // e um pop-up aberto significa que alguém está no meio de algo
      if (!podeMostrar()) return;
      if (document.querySelector("#modais .modal")) { armar(); return; }
      if (document.visibilityState !== "visible") { armar(); return; }
      mostrar();
    }, segundosOciosos() * 1000);
  }

  // ==================================================================
  //  MOSTRAR E ESCONDER
  // ==================================================================
  function mostrar() {
    if (ligado) return;
    var itens = lista();
    if (!itens.length) return;

    ligado = true;
    indice = 0;

    caixa = document.createElement("div");
    caixa.className = "propaganda";
    caixa.setAttribute("role", "button");
    caixa.setAttribute("aria-label", "Toque para voltar ao cardápio");
    caixa.innerHTML =
      '<div class="propaganda-palco" id="propPalco"></div>' +
      '<div class="propaganda-rodape">' +
        '<span class="propaganda-toque">Toque na tela para pedir</span>' +
        '<span class="propaganda-quem">' +
          PL.esc((PL.ctx.quiosque && PL.ctx.quiosque.name) || "") +
        "</span>" +
      "</div>";

    // Qualquer toque volta. Usamos a fase de CAPTURA para o dedo não
    // acertar um botão do cardápio por baixo ao acordar a tela.
    ["pointerdown", "touchstart", "keydown"].forEach(function (ev) {
      caixa.addEventListener(ev, aoTocar, true);
    });

    document.body.appendChild(caixa);
    document.body.classList.add("com-propaganda");
    tocarItem();
  }

  function aoTocar(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    esconder();
    ultimoToque = Date.now();
    armar();
  }

  function esconder() {
    clearTimeout(relogioItem);
    relogioItem = null;
    if (caixa) {
      // para o vídeo antes de tirar da tela: sem isso o aparelho pode
      // continuar decodificando em segundo plano e esquentar à toa
      var v = caixa.querySelector("video");
      if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} }
      caixa.remove();
    }
    caixa = null;
    ligado = false;
    document.body.classList.remove("com-propaganda");
  }

  // ==================================================================
  //  O LAÇO
  // ==================================================================
  function tocarItem() {
    if (!ligado || !caixa) return;
    var itens = lista();
    if (!itens.length) { esconder(); return; }

    if (indice >= itens.length) indice = 0;
    var item = itens[indice];
    var palco = caixa.querySelector("#propPalco");
    if (!palco) return;

    clearTimeout(relogioItem);

    // ⚠ CADA ITEM GANHA UM NÚMERO, e todo aviso confere se ainda é o dele.
    //
    // Sem isso o app entrava em laço infinito: um vídeo quebrado dispara
    // 'error', a gente troca de item — mas o elemento antigo continua
    // tentando carregar e dispara 'error' DE NOVO, já fora da tela. Cada
    // erro velho pedia o próximo item, que criava outro elemento, que
    // errava também. Num tablet real isso trava o aparelho.
    geracao += 1;
    var meuTurno = geracao;
    function seguir() {
      if (meuTurno !== geracao) return;   // aviso de um item que já saiu
      proximo();
    }

    // e o elemento que sai precisa PARAR de carregar, não só sumir da tela
    var velho = palco.querySelector("video");
    if (velho) {
      try { velho.pause(); velho.removeAttribute("src"); velho.load(); } catch (e) {}
    }
    palco.innerHTML = "";

    if (item.kind === "video") {
      var v = document.createElement("video");
      v.autoplay = true;
      v.muted = true;          // sem isto o navegador não deixa tocar sozinho
      v.playsInline = true;    // no iPhone, sem isto abre em tela cheia própria
      v.controls = false;
      v.preload = "auto";
      // um item só na lista: deixa o próprio vídeo repetir, que emenda
      // sem o pisco de trocar de elemento
      v.loop = itens.length === 1;

      // ⚠ OS OUVINTES VÊM ANTES DO src. Definir o src começa a carregar na
      // hora, e um arquivo quebrado dispara o 'error' imediatamente — se o
      // ouvinte fosse registrado depois, ninguém ouviria aquele erro e a
      // tela ficaria parada num vídeo preto.
      v.addEventListener("ended", seguir);
      v.addEventListener("error", function () {
        console.warn("Propaganda não tocou:", item.url);
        seguir();
      });

      // Duas redes de segurança, com prazos diferentes:
      //   · não COMEÇOU em 8 s → o arquivo não presta ou não baixou, pula
      //   · começou mas não termina nunca → o teto longo segura
      relogioItem = setTimeout(function () {
        console.warn("Propaganda não começou a tocar:", item.url);
        seguir();
      }, ESPERA_PARA_COMECAR_S * 1000);

      v.addEventListener("playing", function () {
        if (meuTurno !== geracao) return;
        clearTimeout(relogioItem);
        relogioItem = setTimeout(seguir, TETO_DO_VIDEO_S * 1000);
      });

      palco.appendChild(v);
      v.src = item.url;        // só agora: tudo já está escutando
      var p = v.play();
      if (p && p.catch) p.catch(function () { seguir(); });

    } else {
      var img = document.createElement("img");
      img.src = item.url;
      img.alt = item.title || "";
      img.addEventListener("error", function () {
        console.warn("Propaganda não carregou:", item.url);
        seguir();
      });
      palco.appendChild(img);

      var s = Number(item.seconds) || SEGUNDOS_PADRAO;
      relogioItem = setTimeout(seguir, Math.max(2, s) * 1000);
    }
  }

  function proximo() {
    if (!ligado) return;
    clearTimeout(relogioItem);
    indice += 1;
    tocarItem();
  }

  // ==================================================================
  //  LIGAÇÃO COM O RESTO DO APP
  // ==================================================================
  // Qualquer sinal de vida zera o relógio. Vai no documento inteiro e na
  // fase de captura para pegar o toque mesmo dentro de um pop-up.
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (!ligado) { ultimoToque = Date.now(); armar(); }
    }, { capture: true, passive: true });
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") acordou();
    else { clearTimeout(relogioOcioso); if (ligado) esconder(); }
  });

  // O cadastro pode ter mudado (anúncio novo, propaganda desligada).
  PL.ao("catalogo", function () {
    if (ligado && !podeMostrar()) esconder();
    armar();
  });

  // Depois de entrar no app é que sabemos quem é e se a propaganda vale.
  PL.ao("pronto", armar);

  // Deixa o admin ver como ficou sem esperar os dois minutos.
  window.PLPropaganda = {
    testar: function () {
      if (!lista().length) { PL.aviso("Nenhuma propaganda cadastrada.", "avisa"); return; }
      mostrar();
    },
    esconder: esconder,
    armar: armar,
    get ligado() { return ligado; },
  };
})();
