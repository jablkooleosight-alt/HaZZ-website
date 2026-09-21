const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Inicializace Supabase klienta pomocí proměnných prostředí
// (podporujeme jak SUPABASE_*, tak NEXT_PUBLIC_SUPABASE_* - podle toho, jak jsou pojmenované na Vercelu)
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;
if (!supabase) {
  console.error('Supabase není nakonfigurováno – chybí SUPABASE_URL/SUPABASE_ANON_KEY (nebo NEXT_PUBLIC_ varianty). Endpointy závislé na databázi budou vracet 503.');
}

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || process.env.DISCORD_DISCORD_GUILD_ID;
const REDIRECT_URI = process.env.REDIRECT_URI;
const DUTY_WEBHOOK_URL = process.env.WEBHOOK_DUTY_LOG;

// Tajný klíč pro podepisování session cookies. Pokud není nastaven, odvodí se
// z Discord client secretu (je-li k dispozici), jinak se vygeneruje náhodně při
// startu procesu - sessions pak nepřežijí cold start, ale nikdy se nepoužije
// předvídatelný/hardcoded klíč.
const SESSION_SECRET = process.env.SESSION_SECRET || CLIENT_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'hzs_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hodin
const IS_SECURE_ENV = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

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
  "1404448934000201744": "nadrotmajster",
  "1404448934000201787": "rotmajster"
};

const RANK_LEVELS = {
  rotmajster: 1,
  nadrotmajster: 2,
  podpraporcik: 3,
  praporcik: 4,
  nadpraporcik: 5,
  ppor: 6,
  por: 7,
  npor: 8,
  kpt: 9,
  mjr: 10,
  pplk: 11,
  plk: 12,
  reditelstvi: 13
};
const LEAD_LEVEL = 6;
const MAJOR_LEVEL = 10;
const AUTO_APPROVE_LEVEL = 6;
const rankLevel = rank => RANK_LEVELS[rank] || 1;

let dutyMessageId = null;

// ==================== SESSION HELPERY ====================

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signSession(payload) {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  const session = verifySession(cookies[SESSION_COOKIE]);
  req.authUser = session ? { id: session.id, rank: session.rank, name: session.name } : null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Nejste přihlášen(a).' });
  next();
}

function requireMinLevel(level) {
  return (req, res, next) => {
    if (!req.authUser || rankLevel(req.authUser.rank) < level) {
      return res.status(403).json({ error: 'Nedostatečné oprávnění pro tuto akci.' });
    }
    next();
  };
}

function requireSupabase(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Databáze není nakonfigurována na serveru.' });
  next();
}

// Zaloguje chybu na server (aby byla vidět v runtime logách) a pošle ji i klientovi.
function sendError(res, err, code = 500) {
  console.error(err);
  res.status(code).json({ error: err.message });
}

// Přidělí týdenní prémii zúčastněným členům za schválený výjezd.
async function awardBonuses(incident) {
  if (!supabase) return;
  const involvedIds = [...new Set([incident.commanderId, ...(incident.memberIds || [])].filter(Boolean))];
  for (const mId of involvedIds) {
    try {
      const bonus = incident.type === 'pozar'
        ? Math.floor(Math.random() * (1500 - 1200 + 1)) + 1200
        : Math.floor(Math.random() * (1300 - 1000 + 1)) + 1000;
      const { data: rows } = await supabase.from('members').select('weekly_bonuses').eq('id', mId).limit(1);
      const current = (rows && rows[0] && rows[0].weekly_bonuses) || {};
      current[incident.id] = bonus;
      await supabase.from('members').update({ weekly_bonuses: current }).eq('id', mId);
    } catch (e) {
      console.error(`Chyba při udělování prémie členovi ${mId}:`, e.message);
    }
  }
}

// ==================== DISCORD AUTENTIZACE ====================

app.get('/api/auth/url', (req, res) => {
  try {
    if (!CLIENT_ID || !REDIRECT_URI) {
      console.error("Chybí proměnné prostředí: CLIENT_ID nebo REDIRECT_URI");
      return res.status(500).json({ error: 'Chybí konfigurace Discord CLIENT_ID nebo REDIRECT_URI na serveru.' });
    }
    const url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds.members.read`;
    res.json({ url });
  } catch (err) {
    sendError(res, err);
  }
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

    // Server-side ověřená session - klient si SVOJI hodnost nemůže sám nastavit,
    // veškerá autorizace na API se odvozuje z tohoto podepsaného cookie, ne z dat v URL.
    const sessionToken = signSession({
      id: userData.id,
      rank: userRank,
      name: userData.name,
      exp: Date.now() + SESSION_TTL_MS
    });
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: IS_SECURE_ENV,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/'
    });

    const encodedUser = encodeURIComponent(JSON.stringify(userData));
    res.redirect(`/#/login-success?user=${encodedUser}`);

  } catch (err) {
    console.error('Chyba při autentizaci:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

// ==================== ČLENOVÉ (DISCORD + SUPABASE SYNC) ====================

app.get('/api/members', requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    const discordMembers = response.data
      .map(m => {
        let rank = null;
        for (const roleId of m.roles) {
          if (ROLE_MAP[roleId]) {
            rank = ROLE_MAP[roleId];
            break;
          }
        }
        if (!rank) return null;

        return {
          id: m.user.id,
          name: m.nick || m.user.global_name || m.user.username,
          rank: rank,
          number: m.user.id.slice(-3),
          joined: m.joined_at,
          avatar: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` : null
        };
      })
      .filter(m => m !== null);

    let dbMembers = [];
    if (supabase) {
      const { data, error: dbError } = await supabase.from('members').select('*');
      if (dbError) {
        console.error('Chyba při načítání dat členů ze Supabase:', dbError.message);
      } else {
        dbMembers = data || [];
      }
    }

    const dbMap = {};
    dbMembers.forEach(dm => { dbMap[dm.id] = dm; });

    const mergedMembers = discordMembers.map(dm => {
      const stored = dbMap[dm.id] || {};

      if (supabase && !dbMap[dm.id]) {
        supabase.from('members').insert([{
          id: dm.id,
          name: dm.name,
          rank: dm.rank,
          number: dm.number,
          joined: dm.joined,
          avatar: dm.avatar,
          on_duty: false,
          duty_start: null,
          total_duty_seconds: 0,
          duties_history: [],
          weekly_bonuses: []
        }]).then(({ error }) => {
          if (error) console.error(`Chyba při vytvoření člena ${dm.name}:`, error.message);
        });
      }

      return {
        ...dm,
        on_duty: stored.on_duty !== undefined ? stored.on_duty : false,
        duty_start: stored.duty_start !== undefined ? stored.duty_start : null,
        total_duty_seconds: stored.total_duty_seconds !== undefined ? stored.total_duty_seconds : 0,
        duties_history: stored.duties_history || [],
        weekly_bonuses: stored.weekly_bonuses || []
      };
    });

    res.json(mergedMembers);
  } catch (err) {
    console.error('Chyba při načítání členů:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nelze načíst členy z Discordu.' });
  }
});

// Lehký endpoint jen pro sledování stavu služby (bez volání Discord API) -
// bezpečný pro časté pollování z klienta.
app.get('/api/members/status', requireAuth, requireSupabase, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('members')
      .select('id, on_duty, duty_start, duties_history, weekly_bonuses');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/members', requireAuth, requireMinLevel(MAJOR_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { data, error } = await supabase.from('members').insert([req.body]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
});

async function updateMember(req, res) {
    try {
        const { id } = req.params;
        const isSelf = req.authUser.id === id;
        const isPrivileged = rankLevel(req.authUser.rank) >= MAJOR_LEVEL;

        if (!isSelf && !isPrivileged) {
            return res.status(403).json({ error: 'Nedostatečné oprávnění pro úpravu tohoto člena.' });
        }

        let payload = req.body;
        if (isSelf && !isPrivileged) {
            // Běžný člen si smí měnit jen stav vlastní služby, ne hodnost/jméno/prémie.
            const allowed = ['on_duty', 'duty_start', 'duties_history'];
            payload = {};
            allowed.forEach(k => { if (k in req.body) payload[k] = req.body[k]; });
        }

        const { data, error } = await supabase.from('members').update(payload).eq('id', id).select();
        if (error) throw error;

        if (!data || data.length === 0) {
            if (!isPrivileged) {
                return res.status(404).json({ error: 'Člen nenalezen.' });
            }
            const insertPayload = { id, ...payload };
            const { data: insData, error: insError } = await supabase.from('members').insert([insertPayload]).select();
            if (insError) throw insError;
            return res.json(insData[0]);
        }
        res.json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
}

app.put('/api/members/:id', requireAuth, requireSupabase, updateMember);
app.patch('/api/members/:id', requireAuth, requireSupabase, updateMember);

app.delete('/api/members/:id', requireAuth, requireMinLevel(MAJOR_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('members').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        sendError(res, err);
    }
});

// ==================== VÝJEZDY (SUPABASE) ====================

app.get('/api/incidents', requireAuth, requireSupabase, async (req, res) => {
    try {
        const { data, error } = await supabase.from('incidents').select('*').order('datetime', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        sendError(res, err);
    }
});

app.post('/api/incidents', requireAuth, requireSupabase, async (req, res) => {
    try {
        const { data: existing, error: listErr } = await supabase.from('incidents').select('number');
        if (listErr) throw listErr;

        const year = new Date().getFullYear();
        let maxN = 0;
        (existing || []).forEach(r => {
            const m = /-(\d+)$/.exec(String(r.number || ''));
            if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
        });
        const number = `VYJ-${year}-${String(maxN + 1).padStart(3, '0')}`;

        const autoApprove = rankLevel(req.authUser.rank) >= AUTO_APPROVE_LEVEL;
        const payload = {
            ...req.body,
            number,
            commanderId: req.authUser.id,
            authorId: req.authUser.id,
            status: autoApprove ? 'approved' : 'pending'
        };

        const { data, error } = await supabase.from('incidents').insert([payload]).select();
        if (error) throw error;
        const created = data[0];
        if (created.status === 'approved') await awardBonuses(created);
        res.status(201).json(created);
    } catch (err) {
        sendError(res, err);
    }
});

async function updateIncident(req, res) {
    try {
        const { id } = req.params;
        const { data: rows, error: findErr } = await supabase.from('incidents').select('*').eq('id', id).limit(1);
        if (findErr) throw findErr;
        const existing = rows && rows[0];
        if (!existing) return res.status(404).json({ error: 'Výjezd nenalezen.' });

        const isOwner = existing.commanderId === req.authUser.id;
        const isLeadUser = rankLevel(req.authUser.rank) >= LEAD_LEVEL;
        if (!isOwner && !isLeadUser) {
            return res.status(403).json({ error: 'Nedostatečné oprávnění pro úpravu tohoto výjezdu.' });
        }

        const body = { ...req.body };
        delete body.id;
        delete body.commanderId;
        delete body.authorId;
        delete body.number;
        // Schválit výjezd smí jen vedení - běžný člen tuto změnu nemůže protlačit.
        if (body.status && body.status !== existing.status && body.status === 'approved' && !isLeadUser) {
            delete body.status;
        }

        const { data, error } = await supabase.from('incidents').update(body).eq('id', id).select();
        if (error) throw error;
        const updated = data[0];
        if (existing.status !== 'approved' && updated.status === 'approved') {
            await awardBonuses(updated);
        }
        res.json(updated);
    } catch (err) {
        sendError(res, err);
    }
}

app.put('/api/incidents/:id', requireAuth, requireSupabase, updateIncident);
app.patch('/api/incidents/:id', requireAuth, requireSupabase, updateIncident);

app.delete('/api/incidents/:id', requireAuth, requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { data: rows } = await supabase.from('incidents').select('commanderId').eq('id', id).limit(1);
        const existing = rows && rows[0];
        if (existing) {
            const isOwner = existing.commanderId === req.authUser.id;
            const isLeadUser = rankLevel(req.authUser.rank) >= LEAD_LEVEL;
            if (!isOwner && !isLeadUser) {
                return res.status(403).json({ error: 'Nedostatečné oprávnění pro smazání tohoto výjezdu.' });
            }
        }
        const { error } = await supabase.from('incidents').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        sendError(res, err);
    }
});

// ==================== SLUŽBY (SUPABASE) ====================

app.get('/api/services', requireAuth, requireSupabase, async (req, res) => {
    try {
        const { data, error } = await supabase.from('services').select('*').order('date', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        sendError(res, err);
    }
});

app.post('/api/services', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { data, error } = await supabase.from('services').insert([req.body]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
});

app.put('/api/services/:id', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('services').update(req.body).eq('id', id).select();
        if (error) throw error;
        res.json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
});

app.patch('/api/services/:id', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('services').update(req.body).eq('id', id).select();
        if (error) throw error;
        res.json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
});

app.delete('/api/services/:id', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('services').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        sendError(res, err);
    }
});

// ==================== SMĚRNICE (SUPABASE) ====================

app.get('/api/guidelines', requireAuth, requireSupabase, async (req, res) => {
    try {
        const { data, error } = await supabase.from('guidelines').select('*').order('date', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        sendError(res, err);
    }
});

app.post('/api/guidelines', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { data, error } = await supabase.from('guidelines').insert([req.body]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
});

app.patch('/api/guidelines/:id', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const body = { ...req.body };
        delete body.id;
        const { data, error } = await supabase.from('guidelines').update(body).eq('id', id).select();
        if (error) throw error;
        res.json(data[0]);
    } catch (err) {
        sendError(res, err);
    }
});

app.delete('/api/guidelines/:id', requireAuth, requireMinLevel(LEAD_LEVEL), requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('guidelines').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        sendError(res, err);
    }
});

// ==================== DISCORD DUTY SYNC ====================

app.post('/api/duty-sync', requireAuth, async (req, res) => {
  const { activeMembers } = req.body;
  if (!DUTY_WEBHOOK_URL) return res.status(400).json({ error: 'Není nastaven Webhook' });

  let listText = activeMembers && activeMembers.length > 0
    ? activeMembers.map(m => `• **${m.name}** (${m.rankName || m.rank})`).join('\n')
    : '_Momentálně není nikdo ve službě._';

  const currentDateTime = new Date().toLocaleString('cs-CZ', {
    dateStyle: 'short',
    timeStyle: 'medium'
  });

  const embedPayload = {
    embeds: [{
      title: '📋 Aktuální seznam ve službě (HZS)',
      description: listText,
      color: activeMembers && activeMembers.length > 0 ? 3066993 : 15158332,
      footer: { text: `Poslední aktualizace: ${currentDateTime}` }
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
  console.log(`Server běží na portu ${PORT}, Discord integrace a Supabase jsou aktivní.`);
});

module.exports = app;
