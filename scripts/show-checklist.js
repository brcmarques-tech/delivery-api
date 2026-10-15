/**
 * Imprime o PROPOSED_CHANGES_CHECKLIST.md no terminal.
 *
 * Utilitario de desenvolvimento, sem efeito em runtime: existe para o checklist
 * de mudancas propostas ser lido sem sair do terminal (`node scripts/show-checklist.js`).
 * Nao e usado por nenhum caminho da API — se o checklist deixar de existir, este
 * script pode ser removido junto.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'PROPOSED_CHANGES_CHECKLIST.md');
try {
  const content = fs.readFileSync(file, 'utf8');
  console.log(content);
} catch (err) {
  console.error('Erro ao ler checklist:', err.message);
  process.exit(1);
}
