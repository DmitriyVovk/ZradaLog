const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const fixed = html.replace(/src="\/assets\//g, 'src="./assets/');
fs.writeFileSync(htmlPath, fixed);
console.log('Fixed HTML asset paths');