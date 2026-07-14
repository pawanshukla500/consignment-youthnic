const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'PackingStation.jsx');
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

const query = process.argv[2] || 'kickScanDrain';
console.log(`Searching for "${query}" in PackingStation.jsx...`);

lines.forEach((line, i) => {
  if (line.toLowerCase().includes(query.toLowerCase())) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
