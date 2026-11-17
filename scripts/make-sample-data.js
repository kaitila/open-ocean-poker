// Generates obviously-fictional placeholder players so the site works before
// the real line-up is imported. Run: node scripts/make-sample-data.js
const fs = require('fs');
const path = require('path');

const first = ['Aino','Mikael','Sofia','Leo','Ella','Oskar','Isla','Noah','Venla','Elias','Maya','Hugo','Lumi','Aaron','Iris','Otto','Nora','Eetu','Freya','Daniel','Selma','Max','Clara','Jonas','Ada','Felix','Linnea','Theo','Sara','Kasper','Mila','Viktor','Alma','Rasmus','Ines','Matias','Hanna','Lucas','Emilia','Samuel'];
const last = ['Example','Placeholder','Sample','Demo','Testinen','Mockley','Stand-in','Dummy'];
const cos = ['Kelp Robotics','Fjord Data','Tundra AI','Harbor Labs','Aurora Security','Saimaa Bio','Glacier Cloud','Lighthouse Capital','Archipelago Ventures','Seastack Partners'];
const roles = ['founder','founder','founder','investor','investor','operator'];
const titles = { founder: ['Co-founder & CEO','Co-founder & CTO','Founder'], investor: ['Partner','Principal','Investor'], operator: ['Head of Growth','VP Engineering','COO'] };
const TABLES = 5, SEATS = 8;

const tables = [];
const players = [];
let n = 0;
for (let t = 0; t < TABLES; t++) {
  const tid = String.fromCharCode(65 + t);
  tables.push({ id: tid, name: `Table ${tid}` });
  for (let s = 1; s <= SEATS; s++) {
    const role = roles[n % roles.length];
    const name = `${first[n % first.length]} ${last[n % last.length]}`;
    players.push({
      id: `p${String(n + 1).padStart(2, '0')}`,
      name,
      title: titles[role][n % 3],
      company: role === 'investor' ? cos[6 + (n % 4)] : cos[n % 6],
      role,
      table: tid,
      seat: s,
      photo: '',
      linkedin: '',
      bio: 'Placeholder profile — replace with the real player line-up (see README).',
      firstTimer: n % 3 === 0,
      host: false,
    });
    n++;
  }
}
const dir = path.join(__dirname, '..', 'data');
fs.writeFileSync(path.join(dir, 'tables.json'), JSON.stringify(tables, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(players, null, 2) + '\n');
console.log(`Wrote ${tables.length} tables, ${players.length} players`);
