const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); // Serve static files (html/css/js)

// Database Setup
const db = new sqlite3.Database('./voting.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to the SQLite database.');
});

// Initialize Tables
db.serialize(() => {
    // Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        regNum TEXT PRIMARY KEY,
        name TEXT,
        password TEXT,
        role TEXT,
        year TEXT,
        branch TEXT,
        section TEXT,
        symbol TEXT,
        hasVoted INTEGER DEFAULT 0,
        votedFor TEXT
    )`);

    // Election Status Table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // Default Admin
    const admin = {
        regNum: 'ADMIN001',
        name: 'System Administrator',
        password: 'admin123',
        role: 'admin'
    };

    db.run(`INSERT OR IGNORE INTO users (regNum, name, password, role) VALUES (?, ?, ?, ?)`,
        [admin.regNum, admin.name, admin.password, admin.role]);

    // Default Election Status
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('electionActive', 'false')`);
});

// --- API Endpoints ---

// Get Election Status
app.get('/api/status', (req, res) => {
    db.get(`SELECT value FROM settings WHERE key = 'electionActive'`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ isActive: row ? row.value === 'true' : false });
    });
});

// Toggle Election
app.post('/api/election/toggle', (req, res) => {
    const { isActive } = req.body; // Boolean
    db.run(`UPDATE settings SET value = ? WHERE key = 'electionActive'`, [isActive.toString()], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, isActive });
    });
});

// Login
app.post('/api/login', (req, res) => {
    const { regNum, password } = req.body;
    db.get(`SELECT * FROM users WHERE regNum = ? AND password = ?`, [regNum, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            // Convert binary ints to boolean for JS
            row.hasVoted = !!row.hasVoted;
            res.json(row);
        } else {
            res.status(401).json({ error: "Invalid credentials" });
        }
    });
});

// Register
app.post('/api/register', (req, res) => {
    const { regNum, name, password, role, year, branch, section, symbol } = req.body;

    db.run(`INSERT INTO users (regNum, name, password, role, year, branch, section, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [regNum, name, password, role, year, branch, section, symbol],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: "Registration Number already exists." });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Vote
app.post('/api/vote', (req, res) => {
    const { voterId, candidateId } = req.body;
    db.run(`UPDATE users SET hasVoted = 1, votedFor = ? WHERE regNum = ?`, [candidateId, voterId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Get Stats (Admin)
app.get('/api/stats', (req, res) => {
    db.all(`SELECT * FROM users`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // Process data for frontend similar to old StorageManager
        const contestants = rows.filter(u => u.role === 'contestant');
        const voters = rows.filter(u => u.role === 'voter');
        const totalVotes = voters.filter(v => v.hasVoted === 1).length;

        const candidateVotes = {};
        contestants.forEach(c => candidateVotes[c.regNum] = 0);
        voters.forEach(v => {
            if (v.hasVoted === 1 && v.votedFor) {
                if (candidateVotes[v.votedFor] !== undefined) candidateVotes[v.votedFor]++;
            }
        });

        res.json({
            totalContestants: contestants.length,
            totalVoters: voters.length,
            votesCast: totalVotes,
            votesNotCast: voters.length - totalVotes,
            candidateVotes,
            contestants,
            voters: voters.map(v => ({ ...v, hasVoted: !!v.hasVoted })) // normalize
        });
    });
});

// Reset Data
app.post('/api/admin/reset', (req, res) => {
    const { role } = req.body; // 'voter' or 'contestant'
    if (!role) return res.status(400).json({ error: "Role required" });

    db.run(`DELETE FROM users WHERE role = ?`, [role], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Change Password
app.post('/api/admin/password', (req, res) => {
    const { regNum, newPassword } = req.body;
    db.run(`UPDATE users SET password = ? WHERE regNum = ?`, [newPassword, regNum], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
