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
