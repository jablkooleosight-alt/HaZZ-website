const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Inicializace Supabase klienta
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const REDIRECT_URI = process.env.REDIRECT_URI;
const DUTY_WEBHOOK_URL = process.env.WEBHOOK_DUTY_LOG;

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

let dutyMessageId = null;

// ==================== DISCORD AUTENTIZACE ====================

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
      rank: userRank
    };

    const encodedUser = encodeURIComponent(JSON.stringify(userData));
    res.redirect(`/#/login-success?user=${encodedUser}`);

  } catch (err) {
    console.error('Chyba při autentizaci:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

// ==================== ČLENOVÉ (DISCORD + SUPABASE) ====================

app.get('/api/members', async (req, res) => {
  try {
    const response = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    const members = response.data.map(m => {
      let rank = 'rotmajster';
      for (const roleId of m.roles) {
        if (ROLE_MAP[roleId]) {
          rank = ROLE_MAP[roleId];
          break;
        }
      }
      return {
        id: m.user.id,
        discord_id: m.user.id,
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

// Uložení člena do Supabase (odpovídá sloupcům z tvého obrázku)
app.post('/api/members', async (req, res) => {
    try {
        const { data, error } = await supabase.from('members').insert([req.body]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== VÝJEZDY (SUPABASE) ====================

app.get('/api/incidents', async (req, res) => {
    try {
        const { data, error } = await supabase.from('incidents').select('*').order('datetime', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/incidents', async (req, res) => {
    try {
        const { data, error } = await supabase.from('incidents').insert([req.body]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/incidents/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('incidents').update(req.body).eq('id', id).select();
        if (error) throw error;
        res.json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== DISCORD DUTY SYNC ====================

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server běží na portu ${PORT}, Discord a Supabase jsou připraveny.`);
});

module.exports = app;
