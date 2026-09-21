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
  "1404448934000201788": "rotmajster" // opravené unikátní ID pro rotmajstra (případně si uprav podle svého Discordu)
};

// V endpointu /api/members musí být tento filtr:
app.get('/api/members', async (req, res) => {
  try {
    const response = await axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    const members = response.data
      .filter(m => {
        if (m.user.bot) return false; // Spolehlivě vyhodí boty
        if (!m.roles) return false;
        // Povolí pouze ty, co mají alespoň jednu roli z našeho ROLE_MAP
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
