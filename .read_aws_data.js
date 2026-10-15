const fs = require('fs');
const html = fs.readFileSync('/workspace/index.html', 'utf8');
const m = html.match(/<script\s+id=["']data["'][^>]*>([\s\S]*?)<\/script>/);
const data = JSON.parse(m[1]);
const aws = data.providers.find(p => p.id === 'aws');
console.log('AWS found:', !!aws);
if (aws) {
  console.log('models:', aws.models.length);
  console.log(JSON.stringify(aws.models.map(x => ({ g: x.g, n: x.n, v: x.v, card: x.card })), null, 2));
}
