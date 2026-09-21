const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const REDIRECT_URI = process.env.REDIRECT_URI;
const DUTY_WEBHOOK_URL = process.env.WEBHOOK_DUTY_LOG;

// Zachované reálné ID rolí z vašeho nastavení
const ROLE_MAP = {
  "1547544440170741810": "reditelstvi",
  "1404448934050529290": "plk",
  "1404448934021300353": "pplk",    
  "1404448934021300352": "mjr",
  "1404448934021300351": "kpt",
  "1404448934021300350": "npor",
  "1404448934021300349": "por",
  "1404448934021300348": "ppor",
  "1404448934021300347": "nadpraporcik",
  "1404448934021300346": "praporcik",
  "1404448934021300345": "podpraporcik",
  "1404448934021300344": "nadrotmajster",
  "1404448934000201787": "rotmajster"
};

// Hodnosti s oprávněním správy (Vedení a Vyšší důstojníci)
const MANAGING_RANKS = ['reditelstvi', 'plk', 'pplk', 'mjr', 'kpt'];
const BONUS_RANKS = ['reditelstvi', 'plk', 'pplk', 'mjr'];

// Paměťová úložiště pro běh aplikace
let dutyMessageId = null;
let guidelines = [];
let divisions = [];
let incidents = [];

// Pomocná funkce pro výpočet odslouženého času z časové značky
function formatDuration(startedAt) {
  if (!startedAt) return '00:00:00';
  const diffMs = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':');
}

app.get('/api/auth/url', (req, res) => {
  const url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds.members.read`;
  res.json({ url });
});

app.get('/api/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Chybí kód.');

  try {
    const tokenParams = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    });

    const tokenRes = await axios.post('https://discord.com/api/v10/oauth2/token', tokenParams, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data.access_token;

    const memberRes = await axios.get(`https://discord.com/api/v10/users/@me/guilds/${GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const memberData = memberRes.data;
    
    let userRank = 'rotmajster';
    if (memberData.roles) {
      for (const roleId of memberData.roles) {
        if (ROLE_MAP[roleId]) {
          userRank = ROLE_MAP[roleId];
          break;
        }
      }
    }

    const userData = {
      id: memberData.user.id,
      name: memberData.nick || memberData.user.global_name || memberData.user.username,
      avatar: memberData.user.avatar 
        ? `https://cdn.discordapp.com/avatars/${memberData.user.id}/${memberData.user.avatar}.png`
        : null,
      rank: userRank,
      canManage: MANAGING_RANKS.includes(userRank),
      canSeeBonuses: BONUS_RANKS.includes(userRank)
    };

    const encodedUser = encodeURIComponent(JSON.stringify(userData));
    res.redirect(`/#/login-success?user=${encodedUser}`);

  } catch (err) {
    console.error('Chyba při autentizaci:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

// Endpoint načítající všechny členy z Discordu s podporou rolí
app.get('/api/members', async (req, res) => {
  try {
    const response = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    const members = [];
    
    for (const m of response.data) {
      if (m.user && !m.user.bot) {
        let assignedRank = null;
        if (m.roles && Array.isArray(m.roles)) {
          for (const roleId of m.roles) {
            if (ROLE_MAP[roleId]) {
              assignedRank = ROLE_MAP[roleId];
              break;
            }
          }
        }

        // Zahrneme pouze uživatele, kteří mají přiřazenou roli v HZS
        if (assignedRank) {
          members.push({
            id: m.user.id,
            name: m.nick || m.user.global_name || m.user.username,
            rank: assignedRank,
            number: m.user.id.slice(-3),
            joined: m.joined_at,
            avatar: m.user.avatar 
              ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` 
              : null
          });
        }
      }
    }

    res.json(members);
  } catch (err) {
    console.error('Chyba při načítání členů:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nelze načíst členy z Discordu.' });
  }
});

// Aktualizace služby na Discord Webhooku včetně přesného času
app.post('/api/duty-sync', async (req, res) => {
  const { activeMembers } = req.body;
  if (!DUTY_WEBHOOK_URL) return res.status(400).json({ error: 'Není nastaven Webhook' });

  let listText = '_Momentálně není nikdo ve službě._';

  if (activeMembers && activeMembers.length > 0) {
    listText = activeMembers.map(m => {
      const elapsed = m.startedAt ? formatDuration(m.startedAt) : '00:00:00';
      return `• **${m.name}** (${m.rankName}) — *Čas ve službě: ${elapsed}*`;
    }).join('\n');
  }

  const embedPayload = {
    embeds: [{
      title: '📋 Aktuální seznam ve službě (HZS)',
      description: listText,
      color: activeMembers.length > 0 ? 3066993 : 15158332,
      footer: { text: `Poslední aktualizace: ${new Date().toLocaleTimeString('cs-CZ')}` }
    }]
  };

  try {
    if (dutyMessageId) {
      await axios.patch(`${DUTY_WEBHOOK_URL}/messages/${dutyMessageId}`, embedPayload);
    } else {
      const resp = await axios.post(`${DUTY_WEBHOOK_URL}?wait=true`, embedPayload);
      dutyMessageId = resp.data.id;
    }
    res.json({ success: true });
  } catch (err) {
    try {
      const resp = await axios.post(`${DUTY_WEBHOOK_URL}?wait=true`, embedPayload);
      dutyMessageId = resp.data.id;
      res.json({ success: true });
    } catch (e) {
      console.error('Chyba aktualizace služby na Discordu:', e.message);
      res.status(500).json({ error: 'Chyba webhooku' });
    }
  }
});

// ==========================================
// API ENDPOINTY PRO SPRÁVU A FUNKCE
// ==========================================

// --- INCIDENTY / VÝJEZDY ---
app.get('/api/incidents', (req, res) => {
  res.json(incidents);
});

app.post('/api/incidents', (req, res) => {
  const newIncident = { id: Date.now().toString(), status: 'pending', ...req.body };
  incidents.unshift(newIncident);
  res.json(newIncident);
});

app.delete('/api/incidents/:id', (req, res) => {
  const { id } = req.params;
  incidents = incidents.filter(inc => inc.id !== id);
  res.json({ success: true, message: 'Incident byl úspěšně smazán.' });
});

// --- SMĚRNICE ---
app.get('/api/guidelines', (req, res) => {
  res.json(guidelines);
});

app.post('/api/guidelines', (req, res) => {
  const newGuideline = { id: Date.now().toString(), createdAt: new Date().toISOString(), ...req.body };
  guidelines.unshift(newGuideline);
  res.json(newGuideline);
});

app.put('/api/guidelines/:id', (req, res) => {
  const { id } = req.params;
  const index = guidelines.findIndex(g => g.id === id);
  if (index !== -1) {
    guidelines[index] = { ...guidelines[index], ...req.body, updatedAt: new Date().toISOString() };
    return res.json(guidelines[index]);
  }
  res.status(404).json({ error: 'Směrnice nenalezena' });
});

app.delete('/api/guidelines/:id', (req, res) => {
  const { id } = req.params;
  guidelines = guidelines.filter(g => g.id !== id);
  res.json({ success: true });
});

// --- DIVIZE A JEJICH ČLENOVÉ ---
app.get('/api/divisions', (req, res) => {
  res.json(divisions);
});

app.post('/api/divisions', (req, res) => {
  const newDivision = { id: Date.now().toString(), members: [], ...req.body };
  divisions.push(newDivision);
  res.json(newDivision);
});

app.delete('/api/divisions/:id', (req, res) => {
  const { id } = req.params;
  divisions = divisions.filter(d => d.id !== id);
  res.json({ success: true });
});

app.post('/api/divisions/:id/members', (req, res) => {
  const { id } = req.params;
  const division = divisions.find(d => d.id === id);
  if (division) {
    const member = req.body;
    division.members.push(member);
    return res.json(division);
  }
  res.status(404).json({ error: 'Divize nenalezena' });
});

app.delete('/api/divisions/:divId/members/:memberId', (req, res) => {
  const { divId, memberId } = req.params;
  const division = divisions.find(d => d.id === divId);
  if (division) {
    division.members = division.members.filter(m => m.id !== memberId);
    return res.json(division);
  }
  res.status(404).json({ error: 'Divize nenalezena' });
});

module.exports = app;
