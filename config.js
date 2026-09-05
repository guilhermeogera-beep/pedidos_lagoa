// =====================================================================
//  CONFIGURAÇÃO DO PEDIDOS LAGOA
// =====================================================================
//
//  Estes são os valores INICIAIS (de fábrica). Depois que o admin salvar
//  as configurações na engrenagem ⚙, o que vale é o que está guardado na
//  nuvem (tabela `tenants`) — igual em todos os aparelhos.
//
//  ⚠ ESTE ARQUIVO VAI PARA O AR junto com o app. Qualquer pessoa que abra
//    o endereço consegue ler tudo o que está escrito aqui. Por isso não
//    guardamos NENHUMA senha nele: quem protege as telas é o login, que
//    confere a senha no servidor.
//
//  A chave "publishable" do Supabase pode ficar à vista de propósito —
//  ela sozinha não abre nada. Quem decide o que cada perfil enxerga é a
//  RLS (as regras de segurança do banco, no arquivo 03-seguranca.sql).
// =====================================================================

window.PEDIDOS_CONFIG = {

  // ------------------------------------------------------------------
  //  MARCA  (white-label: é só trocar aqui para virar outro cliente)
  //  Se o banco tiver nome/cores salvos, o que vem da nuvem vence.
  // ------------------------------------------------------------------
  marca: "Pedidos Lagoa",       // nome do produto, em destaque no topo
  estabelecimento: "Lagoa",     // nome do lugar, como subtítulo

  // Qual cliente este endereço atende. É o `slug` da tabela `tenants`.
  // Serve de conferência: se o login trouxer outro cliente, o app avisa.
  cliente: "lagoa",

  // ------------------------------------------------------------------
  //  LOGIN
  //  A equipe digita só "adm", "recepcao" ou "quiosque7". O app completa
  //  com o domínio abaixo para formar o e-mail que o Supabase exige:
  //     quiosque7  ->  quiosque7@pedidoslagoa.local
  //  Esse domínio não precisa existir de verdade — nada é enviado por
  //  e-mail. Quem digitar o e-mail inteiro (com "@") passa direto.
  // ------------------------------------------------------------------
  dominioLogin: "pedidoslagoa.local",

  // Final acrescentado à senha digitada. Vazio = a senha vai como foi
  // digitada. Só serve se um dia você quiser senhas curtas na tela: com
  // "-lagoa", quem digita "4321" envia "4321-lagoa" (o Supabase exige
  // 6 caracteres ou mais).
  sufixoSenha: "",

  // Sugestões que aparecem embaixo do campo de usuário, para o pessoal
  // não precisar decorar. Deixe [] para esconder.
  atalhosLogin: ["recepcao", "adm"],

  // ------------------------------------------------------------------
  //  TELA DO QUIOSQUE
  // ------------------------------------------------------------------
  pedirNomeCliente: false,   // pede o nome de quem está pedindo
  // O quiosque já diz onde entregar, então perguntar o guarda-sol era um
  // campo a mais para ninguém preencher. Ligue de novo se um dia a casa
  // ficar grande a ponto de o quiosque não bastar.
  pedirLugar: false,         // pede "guarda-sol / mesa" no envio do pedido
  rotuloLugar: "Guarda-sol / mesa",
  obsPorItem: true,          // permite observação em cada item ("sem cebola")
  mostrarPreco: true,        // mostra os preços no cardápio do quiosque
  mostrarMeusPedidos: true,  // aba onde o quiosque acompanha o que pediu
  confirmarEnvio: true,      // pede confirmação antes de mandar o pedido

  // Depois que a recepção lança, o cliente vê "já estamos levando!" por
  // estes minutos. Passado o prazo, vira "finalizado" sozinho — quem
  // fecha o pedido na tela dele é o RELÓGIO, para a recepção não precisar
  // voltar no pedido só para dizer que entregou.
  // (o admin pode mudar isso pela engrenagem, e aí vale o da nuvem)
  minutosACaminho: 10,

  // ------------------------------------------------------------------
  //  TELA DA RECEPÇÃO
  // ------------------------------------------------------------------
  somPedidoNovo: true,       // toca um aviso quando chega pedido
  repetirSom: 0,             // segundos para repetir o aviso enquanto houver
                             // pedido não visto (0 = toca só uma vez)
  mostrarEntreguesHoje: 20,  // quantos pedidos já resolvidos ficam à mostra

  // Semáforo do tempo de espera (minutos). Serve de padrão enquanto o
  // admin não ajustar na engrenagem — depois vale o que está na nuvem.
  slaAtencao: 5,             // a partir daqui o cartão fica âmbar
  slaAtrasado: 12,           // a partir daqui fica vermelho e pisca

  // ------------------------------------------------------------------
  //  TABLET DO QUIOSQUE
  //  Estes valem só para o tablet logado como quiosque — nunca na
  //  recepção (que precisa ver o pedido chegar) nem no celular do cliente
  //  que veio pelo QR (é a bateria dele, e o carrinho dele).
  //  O admin também pode mudar pela engrenagem, e aí vale o da nuvem.
  // ------------------------------------------------------------------
  manterTelaAcesa: true,        // impede o tablet de apagar a tela sozinho
  propagandaLigada: true,       // mostra propaganda depois de um tempo parado
  propagandaAposSegundos: 120,  // 2 minutos sem ninguém tocar (0 = nunca)

  // O tablet é de todo mundo: quem escolhe itens e vai embora sem enviar
  // deixaria o pedido esperando para o próximo pescador mandar sem querer.
  carrinhoLimpaMinutos: 3,      // apaga o carrinho parado (0 = nunca apaga)

  // Motivos prontos do botão "Pediu errado" (a recepção também pode
  // escrever um motivo na hora).
  motivosErro: [
    "Quiosque pediu por engano",
    "Item trocado",
    "Quantidade errada",
    "Cliente desistiu",
    "Produto acabou",
  ],

  // ------------------------------------------------------------------
  //  CONEXÃO COM O BANCO (Supabase)
  //  Pegue os dois valores em: Project Settings → API
  //     supabaseUrl     → Project URL
  //     supabaseAnonKey → chave "publishable" (sb_publishable_...)
  //  Enquanto estiverem vazios, o app abre em MODO DEMONSTRAÇÃO: dá para
  //  navegar por todas as telas com dados de mentira, sem banco nenhum.
  // ------------------------------------------------------------------
  supabaseUrl: "https://jyrewatsfgficuzumuli.supabase.co",
  supabaseAnonKey: "sb_publishable_hvqRv057_VMXoFYcrqqBQA_Eyj1G08s",
};
