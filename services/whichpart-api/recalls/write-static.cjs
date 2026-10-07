'use strict';
const fs = require('fs');
const path = require('path');
const html = require('./html');
const { FAMILIES } = require('./families');
const dest = path.join(__dirname, '..', '..', '..', 'apps', 'whichpart');
function write(rel, body) {
  const full = path.join(dest, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  console.log('wrote ' + rel);
}
const generatedAt = '2026-09-18T00:00:00Z';
write('recalls/index.html', html.indexPage([], generatedAt));
FAMILIES.forEach((f) => {
  write('recalls/' + f.slug + '/index.html', html.familyPage(f.id, [], generatedAt));
});
