import { createClient } from '@supabase/supabase-js';

// Inicializace Supabase klienta
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// Pořadí hodností pro řazení členů (od nejvyšší po nejnižší)
const ROLE_ORDER = [
  'Ředitelství',
  'Plukovník (plk.)',
  'Podplukovník (pplk.)',
  'Major (mjr.)',
  'Kapitán (kpt.)',
  'Nadporučík (npor.)',
  'Poručík (por.)',
  'Vedení',
  'Velitel',
  'Zástupce velitele',
  'Hasič',
  'Nováček'
];

function getRoleRank(roles) {
  if (!roles || roles.length === 0) return 999;
  for (let i = 0; i < ROLE_ORDER.length; i++) {
    if (roles.includes(ROLE_ORDER[i])) return i;
  }
  return 999;
}

export default async function handler(req, res) {
  const { action, id } = req.query;

  // --- 1. NAČTENÍ ČLENŮ Z DISCORDU SE ŘAZENÍM PODLE HODNOSTÍ ---
  if (req.method === 'GET' && (!action || action === 'members')) {
    try {
      const membersRes = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      if (!membersRes.ok) throw new Error('Discord Members API Error');
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
          const mRoles = m.roles.map(rId => rolesMap[rId] || rId);
          return {
            id: m.user.id,
            username: m.user.username,
            displayName: m.nick || m.user.global_name || m.user.username,
            avatar: m.user.avatar 
              ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` 
              : 'https://cdn.discordapp.com/embed/avatars/0.png',
            roles: mRoles
          };
        });

      // Seřazení členů hodnostně
      formatted.sort((a, b) => getRoleRank(a.roles) - getRoleRank(b.roles));

      return res.status(200).json(formatted);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }
  }

  // --- 2. SUPABASE: OZNÁMENÍ (GET / POST / PUT / DELETE) ---
  if (action === 'oznameni') {
    if (!supabase) return res.status(200).json([]);

    if (req.method === 'GET') {
      const { data, error } = await supabase.from('oznameni').select('*').order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { title, content, author, priority } = req.body;
      const { data, error } = await supabase.from('oznameni').insert([{ title, content, author, priority }]).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data[0]);
    }

    if (req.method === 'PUT') {
      const { id: reqId, title, content, author, priority } = req.body;
      const { data, error } = await supabase.from('oznameni').update({ title, content, author, priority }).eq('id', reqId).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data[0]);
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase.from('oznameni').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }
  }

  // --- 3. SUPABASE: SMĚRNICE (GET / POST / PUT / DELETE) ---
  if (action === 'smernice') {
    if (!supabase) return res.status(200).json([]);

    if (req.method === 'GET') {
      const { data, error } = await supabase.from('smernice').select('*').order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { title, category, content } = req.body;
      const { data, error } = await supabase.from('smernice').insert([{ title, category, content }]).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data[0]);
    }

    if (req.method === 'PUT') {
      const { id: reqId, title, category, content } = req.body;
      const { data, error } = await supabase.from('smernice').update({ title, category, content }).eq('id', reqId).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data[0]);
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase.from('smernice').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }
  }

  // --- 4. SUPABASE: VÝJEZDY (GET / POST / PUT / DELETE) ---
  if (action === 'vyjezdy') {
    if (!supabase) return res.status(200).json([]);

    if (req.method === 'GET') {
      const { data, error } = await supabase.from('vyjezdy').select('*').order('date', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { title, location, date, description } = req.body;
      const { data, error } = await supabase.from('vyjezdy').insert([{ title, location, date, description }]).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data[0]);
    }

    if (req.method === 'PUT') {
      const { id: reqId, title, location, date, description } = req.body;
      const { data, error } = await supabase.from('vyjezdy').update({ title, location, date, description }).eq('id', reqId).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data[0]);
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase.from('vyjezdy').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }
  }

  return res.status(404).json({ error: 'Endpoint not found' });
}
