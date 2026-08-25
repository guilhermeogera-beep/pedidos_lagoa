/* ============================================================
   PEDIDOS LAGOA — tela da COZINHA
   ============================================================
   Uma tela só, com um botão só: PRONTO.

   Por que ela é tão simples: quem está na chapa não tem mão livre
   nem tempo de procurar botão. A comanda entra, aparece grande, e
   sai da tela com um toque. Tudo o que não ajuda a fazer a comida
   ficou de fora — preço, nome do cliente, histórico, relatório.

   A cozinha NÃO vê o que é de pesca. A isca e a vara viram outra
   parte do pedido, que a recepção separa no balcão; aqui nem chega.
   E a comanda só aparece DEPOIS que a recepção liberou — assim
   pedido errado não vira comida feita.

   Lembrete de nomes: o que vem do banco fica em inglês
   (kitchen_at, items_count, product_name...). O resto é português.
   ============================================================ */
(function () {
  "use strict";

  var PL = window.PL;

  // Quanto tempo a comanda recém-chegada fica com a moldura âmbar.
  var MS_DESTAQUE = 15000;

  // Onde ficam as preferências deste aparelho. São do TABLET, não da
  // nuvem: a cozinha pode querer letra grande sem mudar nada na recepção.
  var LS_SOM   = "pedidos_lagoa_cozinha_som";
  var LS_LETRA = "pedidos_lagoa_cozinha_letra";

  // ------------------------------------------------------------------
  //  ESTADO
  // ------------------------------------------------------------------
  var viva = false;          // a tela está montada agora?
  var caixa = null;          // o #conteudo
  var novas = {};            // id da comanda -> hora em que ela entrou aqui
  var travadas = {};         // comandas esperando resposta do banco
  var relogio = null;

  function somLigado() {
    if (PL.CFG.cozinhaSom === false) return false;
    try { return localStorage.getItem(LS_SOM) !== "0"; } catch (e) { return true; }
  }
  function letraGrande() {
    try {
      var g = localStorage.getItem(LS_LETRA);
      if (g !== null) return g === "1";
    } catch (e) { /* sem localStorage: vale o config */ }
    return PL.CFG.cozinhaLetraGrande !== false;
  }
  function guardar(chave, ligado) {
    try { localStorage.setItem(chave, ligado ? "1" : "0"); } catch (e) {}
  }

  // ------------------------------------------------------------------
  //  QUAIS COMANDAS SÃO DESTA TELA
  //  Para o perfil 'cozinha' o banco já entrega só isto. O filtro existe
  //  porque o ADMIN também abre esta tela, e para ele PL.partes traz o
  //  pedido inteiro, pesca junto.
  // ------------------------------------------------------------------
  function comandas() {
    return PL.partes.filter(function (t) {
      return t.destination === "cozinha" &&
             (t.status === "cozinha" || t.status === "pronto");
    });
  }

  function preparando() {
    return comandas()
      .filter(function (t) { return t.status === "cozinha"; })
      // a mais antiga em cima: quem entrou primeiro sai primeiro
      .sort(function (a, b) {
        return new Date(a.kitchen_at || a.created_at) - new Date(b.kitchen_at || b.created_at);
      });
  }

  function prontas() {
    var limite = Number(PL.CFG.cozinhaProntasPorPerto);
    if (!(limite > 0)) limite = 6;
    return comandas()
      .filter(function (t) { return t.status === "pronto"; })
      // a última marcada em cima: é a que alguém pode ter apertado errado
      .sort(function (a, b) { return new Date(b.ready_at || 0) - new Date(a.ready_at || 0); })
      .slice(0, limite);
  }

  // ------------------------------------------------------------------
  //  SEMÁFORO
  //  Conta de quando a comanda ENTROU na cozinha, não de quando o
  //  quiosque pediu: a cozinha não tem culpa do tempo que o pedido
  //  ficou esperando a recepção liberar.
  // ------------------------------------------------------------------
  function minutosNaCozinha(t) {
    return PL.minutosDesde(t.kitchen_at || t.created_at);
  }
  // O que vale é o que o admin ajustou na nuvem (⚙ desta aba); o config.js
  // é só o padrão de fábrica, para funcionar antes de alguém configurar.
  function ajuste(nome, padrao) {
    var s = (PL.ctx && PL.ctx.cliente && PL.ctx.cliente.settings) || {};
    return Number(s[nome]) || Number(PL.CFG[nome]) || padrao;
  }
  function atencaoEm()  { return ajuste("cozinhaAtencao", 8); }
  function atrasadoEm() { return ajuste("cozinhaAtrasado", 18); }
  function grau(min) {
    if (min >= atrasadoEm()) return "atrasada";
    if (min >= atencaoEm())  return "atencao";
    return "";
  }

  function nomeDoQuiosque(t) {
    var p = t.pedido || {};
    if (p.quiosque && (p.quiosque.name || p.quiosque.number)) {
      return p.quiosque.name || ("Quiosque " + p.quiosque.number);
    }
    var achado = (PL.catalogo.quiosques || []).filter(function (k) { return k.id === t.kiosk_id; })[0];
    return achado ? (achado.name || ("Quiosque " + achado.number)) : "Quiosque ?";
  }

  function ehNova(t) {
    return !!novas[t.id] && (Date.now() - novas[t.id]) < MS_DESTAQUE;
  }

  // ==================================================================
  //  DESENHO
  // ==================================================================
  function montar(alvo) {
    viva = true;
    caixa = alvo;

    alvo.innerHTML =
      '<section class="card">' +
        '<div class="card-head">' +
          '<h1 class="card-title">👨‍🍳 Cozinha</h1>' +
          '<div class="filtros">' +
            (PL.CFG.cozinhaSom === false ? "" :
              '<label class="switch" title="Toca quando uma comanda entra">' +
                '<input type="checkbox" id="czSom"' + (somLigado() ? " checked" : "") + " />" +
                '<span class="trilho"></span><span>🔔 Som</span>' +
              "</label>") +
            '<label class="switch" title="Aumenta a letra para ler de longe">' +
              '<input type="checkbox" id="czLetra"' + (letraGrande() ? " checked" : "") + " />" +
              '<span class="trilho"></span><span>🔍 Letra grande</span>' +
            "</label>" +
          "</div>" +
        "</div>" +
        '<p class="hint" id="czResumo"></p>' +
      "</section>" +
      '<div id="czPreparando"></div>' +
      '<section class="card" id="czProntas" hidden></section>';

    // Um ouvinte só para a tela toda. O #conteudo é reaproveitado entre as
    // telas, então tiramos o anterior antes de pôr o novo — senão, quem
    // entra e sai da aba três vezes marca a mesma comanda pronta três vezes.
    alvo.removeEventListener("click", cliqueNaTela);
    alvo.addEventListener("click", cliqueNaTela);

    var som = PL.$("#czSom", alvo);
    if (som) {
      som.addEventListener("change", function () {
        guardar(LS_SOM, this.checked);
        if (this.checked) PL.tocarAviso(1);   // confere o volume antes do movimento
        PL.aviso(this.checked ? "Som ligado." : "Som desligado.", "ok");
      });
    }
    PL.$("#czLetra", alvo).addEventListener("change", function () {
      guardar(LS_LETRA, this.checked);
      aplicarLetra();
    });

    aplicarLetra();
    desenhar();
  }

  function aplicarLetra() {
    if (!caixa) return;
    caixa.classList.toggle("cozinha-grande", letraGrande());
  }

  function desenhar() {
    if (!caixa) return;
    var fila = preparando();
    var feitas = prontas();

    var area = PL.$("#czPreparando", caixa);
    var areaProntas = PL.$("#czProntas", caixa);
    if (!area || !areaProntas) return;

    // ---- resumo em uma linha ----
    var atrasadas = fila.filter(function (t) { return minutosNaCozinha(t) >= atrasadoEm(); });
    var linha = PL.$("#czResumo", caixa);
    if (linha) {
      linha.textContent = fila.length
        ? fila.length + (fila.length === 1 ? " comanda na chapa" : " comandas na chapa") +
          (atrasadas.length ? " · ⚠ " + atrasadas.length + " passou de " + atrasadoEm() + " min" : "")
        : "Nada na chapa agora.";
    }

    // ---- o que está sendo preparado ----
    if (!fila.length) {
      area.innerHTML =
        '<div class="vazio">' +
          "<b>Nada para preparar agora.</b>" +
          "Quando a recepção liberar um pedido de comida, ele aparece aqui na hora — com aviso sonoro." +
        "</div>";
    } else {
      area.innerHTML = '<div class="comandas">' + fila.map(cartao).join("") + "</div>";
    }

    // ---- o que já saiu (para desfazer um toque errado) ----
    if (!feitas.length || PL.CFG.cozinhaPodeVoltar === false) {
      areaProntas.hidden = true;
      areaProntas.innerHTML = "";
    } else {
      areaProntas.hidden = false;
      areaProntas.innerHTML =
        '<div class="card-head">' +
          '<h2 class="card-title">✅ Já marcadas como prontas</h2>' +
          '<span class="hint">Esperando a recepção levar. Apertou sem querer? Dá para voltar.</span>' +
        "</div>" +
        '<div class="comandas">' + feitas.map(cartao).join("") + "</div>";
    }
  }

  function cartao(t) {
    var pronta = t.status === "pronto";
    var min = minutosNaCozinha(t);
    var g = pronta ? "" : grau(min);
    var itens = t.itens || [];
    var pedido = t.pedido || {};

    var classes = "comanda" +
      (pronta ? " pronta" : "") +
      (g ? " " + g : "") +
      (ehNova(t) ? " nova" : "");

    // Pronta: mostra a HORA em que saiu, não um relógio correndo — o tempo
    // dela já parou, e um número subindo faria parecer que ainda falta algo.
    var tempo = pronta
      ? '<div class="comanda-tempo"><small>saiu</small>' + PL.esc(PL.hora(t.ready_at)) + "</div>"
      : '<div class="comanda-tempo' + (g ? " " + g : "") + '" data-relogio="' +
        PL.esc(t.kitchen_at || t.created_at) + '"><small>na chapa há</small>' +
        PL.esc(PL.tempoCurto(min)) + "</div>";

    var acoes = pronta
      ? (PL.CFG.cozinhaPodeVoltar === false ? "" :
          '<button type="button" class="btn btn-neutral btn-sm" data-voltar="' + PL.esc(t.id) + '">' +
          "↩ Voltar para a chapa</button>")
      : '<button type="button" class="btn btn-ok" data-pronto="' + PL.esc(t.id) + '">✅ Pronto</button>';

    return '<article class="' + classes + '" data-parte="' + PL.esc(t.id) + '">' +
        '<div class="comanda-topo">' +
          '<div class="comanda-quem">' +
            "<b>" + PL.esc(nomeDoQuiosque(t)) + "</b>" +
            "<span>Pedido #" + PL.esc(pedido.daily_number) +
              " · pedido às " + PL.esc(PL.hora(pedido.created_at)) + "</span>" +
          "</div>" + tempo +
        "</div>" +
        '<div class="comanda-itens">' +
          (itens.length
            ? itens.map(function (i) {
                return '<div class="ci-linha">' +
                    '<span class="q">' + PL.esc(i.qty) + "×</span>" +
                    '<span class="n">' + PL.esc(i.product_name) +
                      (i.notes ? '<span class="obs">' + PL.esc(i.notes) + "</span>" : "") +
                    "</span>" +
                  "</div>";
              }).join("")
            : '<div class="hint">Comanda sem itens — avise a recepção.</div>') +
        "</div>" +
        (pedido.notes ? '<div class="comanda-obs">📝 ' + PL.esc(pedido.notes) + "</div>" : "") +
        '<div class="comanda-pe">' + acoes + "</div>" +
      "</article>";
  }

  // Só o número e a cor mudam a cada tique. Redesenhar tudo faria o dedo
  // perder o botão no meio do toque.
  function atualizarRelogios() {
    if (!caixa) return;
    PL.$$("[data-relogio]", caixa).forEach(function (el) {
      var min = PL.minutosDesde(el.getAttribute("data-relogio"));
      var g = grau(min);
      el.innerHTML = "<small>na chapa há</small>" + PL.esc(PL.tempoCurto(min));
      el.className = "comanda-tempo" + (g ? " " + g : "");
      var art = el.closest(".comanda");
      if (art) {
        art.classList.toggle("atrasada", g === "atrasada");
        art.classList.toggle("atencao", g === "atencao");
        if (art.classList.contains("nova") && !novas[art.dataset.parte]) art.classList.remove("nova");
      }
    });
  }

  // ==================================================================
  //  O BOTÃO
  // ==================================================================
  function cliqueNaTela(ev) {
    var alvo = ev.target.closest("[data-pronto], [data-voltar]");
    if (!alvo) return;
    var id = alvo.getAttribute("data-pronto") || alvo.getAttribute("data-voltar");
    var destino = alvo.hasAttribute("data-pronto") ? "pronto" : "cozinha";
    mudar(id, destino, alvo);
  }

  function mudar(parteId, status, botao) {
    // Um toque duplo marcaria a comanda pronta e já a devolveria para a
    // chapa. A trava é por comanda, não por tela: outra pode ser apertada.
    if (travadas[parteId]) return;
    travadas[parteId] = true;

    var textoAntes = botao ? botao.textContent : "";
    if (botao) { botao.disabled = true; botao.textContent = "Só um instante…"; }

    Promise.resolve(PL.backend.mudarStatusParte(parteId, status, null))
      .then(function () { return PL.recarregarPedidos(); })
      .then(function () {
        PL.vibrar([40]);
        PL.aviso(status === "pronto" ? "Pronto! A recepção já foi avisada." : "Voltou para a chapa.", "ok");
      })
      .catch(function (e) {
        console.error("Cozinha:", e);
        PL.aviso(PL.erroLegivel(e), "erro");
      })
      .then(function () {
        delete travadas[parteId];
        if (botao && botao.isConnected) { botao.disabled = false; botao.textContent = textoAntes; }
      });
  }

  // ==================================================================
  //  AVISOS DO NÚCLEO
  //  Registrados uma vez só, aqui fora: dentro de montar() cada troca de
  //  aba empilharia mais um ouvinte igual, e PL.ao() não desliga nenhum.
  // ==================================================================
  PL.ao("pedidos", function (dados) {
    if (!viva) return;

    // Comanda "chegou" na cozinha de dois jeitos: apareceu já liberada
    // (a tela estava fechada quando a recepção passou) ou acabou de mudar
    // de 'recebido' para 'cozinha' com a tela aberta.
    var chegaram = []
      .concat(((dados && dados.novas) || []).filter(function (t) {
        return t.destination === "cozinha" && t.status === "cozinha";
      }))
      .concat(((dados && dados.mudaram) || [])
        .filter(function (m) {
          return m.para === "cozinha" && m.parte.destination === "cozinha";
        })
        .map(function (m) { return m.parte; }));

    if (chegaram.length) {
      var agora = Date.now();
      chegaram.forEach(function (t) { novas[t.id] = agora; });
      if (somLigado()) PL.tocarAviso(3);
      PL.vibrar([200, 80, 200]);
      PL.aviso(chegaram.length === 1
        ? "🔔 Comanda nova do " + nomeDoQuiosque(chegaram[0])
        : "🔔 " + chegaram.length + " comandas novas", "avisa");
    }

    desenhar();
  });

  PL.ao("tique", function () {
    if (!viva) return;
    atualizarRelogios();
  });

  // Quiosque renomeado muda o texto do cartão.
  PL.ao("catalogo", function () {
    if (viva) desenhar();
  });

  // ==================================================================
  //  REGISTRO DA TELA
  //  O admin também entra aqui — para conferir a tela sem precisar do
  //  login da cozinha. A recepção não: ela já vê tudo no quadro dela, e
  //  mais uma aba só atrapalharia.
  // ==================================================================
  PL.registrarTela({
    id: "cozinha",
    rotulo: "Cozinha",
    icone: "👨‍🍳",
    ordem: 8,
    papeis: ["cozinha", "admin"],

    montar: montar,

    aoEntrar: function () {
      viva = true;
      // O destaque de "comanda nova" precisa acabar mesmo se nada mais
      // mudar no banco — senão a moldura âmbar ficaria a manhã inteira.
      clearInterval(relogio);
      relogio = setInterval(function () {
        if (!viva) return;
        var mexeu = false;
        Object.keys(novas).forEach(function (id) {
          if (Date.now() - novas[id] >= MS_DESTAQUE) { delete novas[id]; mexeu = true; }
        });
        if (mexeu) desenhar();
      }, 5000);
    },

    aoSair: function () {
      viva = false;
      if (caixa) caixa.removeEventListener("click", cliqueNaTela);
      caixa = null;
      clearInterval(relogio);
      relogio = null;
    },

    // A cozinha não configura nada: o ⚙ desta aba ajusta o semáforo dela,
    // e quem faz isso é o admin.
    engrenagem: function () {
      if (window.PLAdmin && typeof window.PLAdmin.configurarCozinha === "function") {
        window.PLAdmin.configurarCozinha();
        return;
      }
      PL.aviso("Os ajustes da cozinha ainda não estão disponíveis.", "avisa");
    },
  });
})();
