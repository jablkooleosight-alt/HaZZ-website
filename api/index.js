import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// Vaše reálné ID rolí
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

// Hierarchie od nejvyšší hodnosti po nejnižší
const ROLE_HIERARCHY = [
  "1547544440170741810", // reditelstvi
  "1404448934050529290", // plk
  "1404448934021300353", // pplk
  "1404448934021300352", // mjr
  "1404448934021300351", // kpt
  "1404448934021300350", // npor
  "1404448934021300349", // por
  "1404448934021300348", // ppor
  "1404448934021300347", // nadpraporcik
  "1404448934021300346", // praporcik
  "1404448934021300345", // podpraporcik
  "1404448934021300344", // nadrotmajster
  "1404448934000201787"  // rotmajster
];

function getMemberHighestRankIndex(userRoleIds) {
  for (let i = 0; i < ROLE_HIERARCHY.length; i++) {
    if (userRoleIds.includes(ROLE_HIERARCHY[i])) return i;
  }
  return 999;
}

export default async function handler(req, res) {
  const { action, id } = req.query;

  // --- 1. ČLENOVÉ Z DISCORDU ---
  if (req.method === 'GET' && (!action || action === 'members')) {
    try {
      const membersRes = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      if (!membersRes.ok) throw new Error('Discord API Error');
      const members = await membersRes.json();

      const rolesRes = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/roles`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      const rolesData = await rolesRes.json();
      const rolesMap = {};
      rolesData.forEach(r => { rolesMap[r.id] = r.name; });

      const formatted = members
        .filter(m => !m.user.bot)
        .map(m => {
          const mRoleNames = m.roles.map(rId => rolesMap[rId] || ROLE_MAP[rId] || rId);
          return {
            id: m.user.id,
            username: m.user.username,
            displayName: m.nick || m.user.global_name || m.user.username,
            avatar: m.user.avatar 
              ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` 
              : 'https://cdn.discordapp.com/embed/avatars/0.png',
            roles: mRoleNames,
            rawRoleIds: m.roles
          };
        });

      // Řazení členů od nejvyšší po nejnižší hodnost
      formatted.sort((a, b) => getMemberHighestRankIndex(a.rawRoleIds) - getMemberHighestRankIndex(b.rawRoleIds));

      return res.status(200).json(formatted);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch members' });
    }
  }

  // --- 2. OZNÁMENÍ ---
  if (action === 'oznameni') {
    if (!supabase) return res.status(200).json([]);
    if (req.method === 'GET') {
      const { data } = await supabase.from('oznameni').select('*').order('created_at', { ascending: false });
      return res.status(200).json(data || []);
    }
    if (req.method === 'POST') {
      const { title, content, author } = req.body;
      const { data } = await supabase.from('oznameni').insert([{ title, content, author }]).select();
      return res.status(200).json(data ? data[0] : {});
    }
    if (req.method === 'PUT') {
      const { id: reqId, title, content, author } = req.body;
      const { data } = await supabase.from('oznameni').update({ title, content, author }).eq('id', reqId).select();
      return res.status(200).json(data ? data[0] : {});
    }
    if (req.method === 'DELETE') {
      await supabase.from('oznameni').delete().eq('id', id);
      return res.status(200).json({ success: true });
    }
  }

  // --- 3. SMĚRNICE ---
  if (action === 'smernice') {
    if (!supabase) return res.status(200).json([]);
    if (req.method === 'GET') {
      const { data } = await supabase.from('smernice').select('*').order('created_at', { ascending: false });
      return res.status(200).json(data || []);
    }
    if (req.method === 'POST') {
      const { title, category, content } = req.body;
      const { data } = await supabase.from('smernice').insert([{ title, category, content }]).select();
      return res.status(200).json(data ? data[0] : {});
    }
    if (req.method === 'PUT') {
      const { id: reqId, title, category, content } = req.body;
      const { data } = await supabase.from('smernice').update({ title, category, content }).eq('id', reqId).select();
      return res.status(200).json(data ? data[0] : {});
    }
    if (req.method === 'DELETE') {
      await supabase.from('smernice').delete().eq('id', id);
      return res.status(200).json({ success: true });
    }
  }

  // --- 4. VÝJEZDY ---
  if (action === 'vyjezdy') {
    if (!supabase) return res.status(200).json([]);
    if (req.method === 'GET') {
      const { data } = await supabase.from('vyjezdy').select('*').order('date', { ascending: false });
      return res.status(200).json(data || []);
    }
    if (req.method === 'POST') {
      const { title, location, date, description } = req.body;
      const { data } = await supabase.from('vyjezdy').insert([{ title, location, date, description }]).select();
      return res.status(200).json(data ? data[0] : {});
    }
    if (req.method === 'PUT') {
      const { id: reqId, title, location, date, description } = req.body;
      const { data } = await supabase.from('vyjezdy').update({ title, location, date, description }).eq('id', reqId).select();
      return res.status(200).json(data ? data[0] : {});
    }
    if (req.method === 'DELETE') {
      await supabase.from('vyjezdy').delete().eq('id', id);
      return res.status(200).json({ success: true });
    }
  }

  return res.status(404).json({ error: 'Not found' });
}
