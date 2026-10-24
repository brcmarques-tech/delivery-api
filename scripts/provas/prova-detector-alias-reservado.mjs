// O DETECTOR DA CLASSE 4 PEGA A LINHA QUE DERRUBOU O SCHEDULER?
//
// A classe 4 de `audita-classes-de-bug.mjs` procura alias de palavra
// RESERVADA colado a uma coluna entre aspas — a forma que derrubou o
// auto-confirm por dias:
//
//   .andWhere('order."codigoVendedor" IS NULL')
//
// Como a varredura reporta ZERO hoje (a ocorrencia foi corrigida), nao da
// para saber olhando o resultado dela se o detector funciona ou se e cego.
// Este arquivo responde isso contra casos conhecidos.
//
// POR QUE ELE EXISTE COMO ARQUIVO, e nao como um node -e rapido: eu rodei
// exatamente este teste por `node -e` primeiro e ele disse que o detector
// era CEGO. Era o escape do shell comendo as aspas — o detector estava
// certo. Quase reescrevi codigo que funcionava por causa de um teste
// quebrado, pela segunda vez no mesmo dia.
const RESERVADAS = [
  'order', 'user', 'group', 'table', 'select', 'from', 'where',
  'limit', 'offset', 'end', 'all', 'check', 'default', 'desc', 'asc',
];

const A = String.fromCharCode(39); // '
const Q = String.fromCharCode(34); // "
const BT = String.fromCharCode(96); // `

const casos = [
  ['a linha EXATA do bug de ontem', `      .andWhere(${A}order.${Q}codigoVendedor${Q} IS NULL${A})`, true],
  ['variante com alias user', `      .andWhere(${A}user.${Q}isActive${Q} = true${A})`, true],
  ['em select, nao em where', `      .addSelect(${A}order.${Q}onlinePaidTotal${Q}${A}, ${A}pago${A})`, true],
  ['o conserto (caminho de propriedade)', `      .andWhere(${A}order.codigoVendedor IS NULL${A})`, false],
  ['alias nao-reservado com sql cru', `      .andWhere(${A}loja.${Q}isOpen${Q} = true${A})`, false],
  ['comentario mencionando o bug', `      // Era ${BT}order.${Q}codigoVendedor${Q} IS NULL${BT},`, false],
];

let falhas = 0;
for (const [rotulo, linha, deveriaPegar] of casos) {
  const ehComentario = /^\s*\*|^\s*\/\//.test(linha);
  const pegou = !ehComentario && RESERVADAS.some((r) => new RegExp('\\b' + r + '\\."').test(linha));
  const ok = pegou === deveriaPegar;
  if (!ok) falhas++;
  console.log(
    `${ok ? 'OK    ' : 'ERRADO'} ${rotulo}` +
      `  (esperado ${deveriaPegar ? 'PEGAR' : 'passar'}, ${pegou ? 'pegou' : 'passou'})`,
  );
}
console.log(falhas === 0 ? '\ndetector correto' : `\n${falhas} caso(s) errado(s)`);
process.exit(falhas === 0 ? 0 : 1);
