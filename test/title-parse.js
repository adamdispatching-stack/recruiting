// The group title: the phone in any form, the name, ELD / Accounting.
//   node test/title-parse.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x@localhost:1/x';
const { titleInfo } = require('../src/tg/bot');
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
for (const t of ['Paul Penn 2675550177', 'Paul Penn 267 555 0177', 'Paul Penn 267-555-0177', 'Paul Penn (267) 555-0177', 'Paul Penn (267)5550177', 'Paul Penn +12675550177',
  'Paul Penn +1 267 555 0177', 'Paul Penn 1-267-555-0177', 'Paul Penn 267.555.0177', 'Paul Penn 267 5550177', 'Paul Penn 26755 50177', '2675550177 Paul Penn', 'Paul Penn - 267 555 0177', 'Paul Penn 267  555  0177']) {
  const i = titleInfo(t); ok(i.phone === '2675550177' && i.name === 'Paul Penn' && i.kind === 'dispatch', `"${t}" → ${i.name} / ${i.phone}`);
}
ok(titleInfo('ELD Paul Penn 2675550177').kind === 'eld' && titleInfo('Paul Penn ELD').name === 'Paul Penn', 'ELD in the title: the ELD group');
ok(titleInfo('Accounting - Paul Penn').kind === 'accounting' && titleInfo('Paul Penn acct').kind === 'accounting', 'Accounting / acct: the accounting group');
ok(titleInfo('Paul Penn 2675550177 / 4845550111').phone === '2675550177', 'two phones: the first');
ok(titleInfo('Paul Penn 555 01').phone === null, 'too few digits: no phone');
ok(titleInfo('José Núñez 2675550177').name === 'José Núñez', 'accented names stay');
for (const [t, k, n, ph] of [['John Smith 2155550177 ELD', 'eld', 'John Smith', '2155550177'], ['ELD_John Smith', 'eld', 'John Smith', null], ['📋ELD John Smith', 'eld', 'John Smith', null],
  ['John Smith (ELD) +1 215 555 0177', 'eld', 'John Smith', '2155550177'], ['John Smith - Eld team', 'eld', 'John Smith', null], ['ЕLD John Smith', 'eld', 'John Smith', null], ['Елд John Smith', 'eld', 'John Smith', null],
  ['John Smith Logs', 'eld', 'John Smith', null], ['Eldon Brooks', 'dispatch', 'Eldon Brooks', null], ['John Smith Accounting', 'accounting', 'John Smith', null], ['ACC John Smith 215 555 0177', 'accounting', 'John Smith', '2155550177'],
  ['John Smith payroll', 'accounting', 'John Smith', null], ['Аccounting John Smith', 'accounting', 'John Smith', null], ['John Smith ELD group 2155550177', 'eld', 'John Smith', '2155550177']]) {
  const i = titleInfo(t); ok(i.kind === k && i.name === n && i.phone === ph, `"${t}" → ${i.kind} / ${i.name} / ${i.phone}`);
}
process.exit(process.exitCode || 0);
