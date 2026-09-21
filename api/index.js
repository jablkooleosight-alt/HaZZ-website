const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// Inicializace Supabase (upravte si dle svých proměnných prostředí nebo vložte klíče)
const supabaseUrl = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const supabaseKey = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

// Definice rolí pro vedení (zde nastavte Discord ID rolí, které patří do vedení)
const LEAD_ROLE_IDS = ['ID_ROLE_VEDENI_1', 'ID_ROLE_VEDENI_2']; 

// Middleware pro ověření, zda je uživatel ve vedení
const requireLeadRole = (req, res, next) => {
    const userRoles = req.headers['x-user-roles'] ? JSON.parse(req.headers['x-user-roles']) : [];
    const isLead = userRoles.some(roleId => LEAD_ROLE_IDS.includes(roleId));
    
    if (!isLead) {
        return res.status(403).json({ error: 'Přístup odepřen: Nemáte oprávnění vedení.' });
    }
    next();
};

// --- ENDPOINTY PRO VÝJEZDY ---

// Získat všechny výjezdy (vidí všichni přihlášení)
app.get('/api/incidents', async (req, res) => {
    try {
        const { data, error } = await supabase.from('incidents').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Vytvořit nový výjezd (může kdokoli, ale stav je výchozí "čekající")
app.post('/api/incidents', async (req, res) => {
    try {
        const incidentData = { ...req.body, status: 'pending' };
        const { data, error } = await supabase.from('incidents').insert([incidentData]).select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schválit výjezd (POUZE VEDENÍ)
app.patch('/api/incidents/:id/approve', requireLeadRole, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('incidents').update({ status: 'approved' }).eq('id', id).select();
        if (error) throw error;
        res.json(data[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Smazat výjezd (POUZE VEDENÍ)
app.delete('/api/incidents/:id', requireLeadRole, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('incidents').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINTY PRO SMĚRNICE ---

app.get('/api/guidelines', async (req, res) => {
    try {
        const { data, error } = await supabase.from('guidelines').select('*');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu ${PORT}`);
});
