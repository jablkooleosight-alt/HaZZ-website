const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors({
  origin: true, 
  credentials: true
}));
app.use(express.json());

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const REDIRECT_URI = process.env.REDIRECT_URI;
const DUTY_WEBHOOK_URL = process.env.WEBHOOK_DUTY_LOG;

// Inicializace Supabase klienta, pokud jsou proměnné dostupné
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

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
  "1404448934000201787": "nadrotmajster",
  "1404448934000201788": "rotmajster"
};

let dutyMessageId = null;

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
    let isLead = false;

    if (memberData.roles) {
      for (const roleId of memberData.roles) {
        if (ROLE_MAP[roleId]) {
          userRank = ROLE_MAP[roleId];
          if (roleId === "1547544440170741810") {
            isLead = true;
          }
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
      isLead: isLead,
      roles: memberData.roles || []
    };

    const encodedUser = encodeURIComponent(JSON.stringify(userData));
    res.redirect(`/#/login-success?user=${encodedUser}`);

  } catch (err) {
    console.error('Chyba při autentizaci:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

/**
 * Bezpečnostní Middleware: Ověření, zda má uživatel práva vedení přes Discord API.
 */
async function requireLeadRole(req, res, next) {
    try {
        const userId = req.headers['x-user-id']; 
        if (!userId) {
            return res.status(401).json({ error: 'Neautorizováno: Chybí identifikace uživatele.' });
        }

        const guildMemberRes = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });

        const memberRoles = guildMemberRes.data.roles || [];
        const hasLeadRole = memberRoles.includes("1547544440170741810");

        if (!hasLeadRole) {
            return res.status(403).json({ error: 'Přístup odepřen: Nemáš oprávnění vedení.' });
        }

        next();
    } catch (error) {
        console.error('Chyba při ověřování oprávnění:', error.response?.data || error.message);
        return res.status(500).json({ error: 'Chyba serveru při ověřování práv.' });
    }
}

// Endpoint pro načtení členů – filtrovaný pouze na HZS role (bez botů)
app.get('/api/members', async (req, res) => {
  try {
    const response = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    const members = response.data
      .filter(m => {
        if (m.user.bot) return false;
        if (!m.roles) return false;
        return m.roles.some(roleId => ROLE_MAP[roleId]);
      })
      .map(m => {
        let rank = 'rotmajster';
        for (const roleId of m.roles) {
          if (ROLE_MAP[roleId]) {
            rank = ROLE_MAP[roleId];
            break;
          }
        }
        return {
          id: m.user.id,
          name: m.nick || m.user.global_name || m.user.username,
          rank: rank,
          number: m.user.id.slice(-3),
          joined: m.joined_at,
          avatar: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` : null
        };
      });

    res.json(members);
  } catch (err) {
    console.error('Chyba při načítání členů:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nelze načíst členy z Discordu.' });
  }
});

// Endpoint pro smazání člena (chráněno pro vedení)
app.delete('/api/members/:id', requireLeadRole, async (req, res) => {
  const userId = req.params.id;

  try {
    await axios.delete(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    res.json({ success: true, message: 'Člen byl úspěšně odstraněn ze serveru.' });
  } catch (err) {
    console.error('Chyba při mazání člena:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nelze odstranit člena z Discordu.' });
  }
});

app.post('/api/duty-sync', async (req, res) => {
  const { activeMembers } = req.body;
  if (!DUTY_WEBHOOK_URL) return res.status(400).json({ error: 'Není nastaven Webhook' });

  let listText = activeMembers.length > 0 
    ? activeMembers.map(m => `• **${m.name}** (${m.rankName})`).join('\n')
    : '_Momentálně není nikdo ve službě._';

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

module.exports = app;
