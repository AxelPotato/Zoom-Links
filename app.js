require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const fs = require('fs'); // to read users.json

const app = express();
const port = process.env.PORT || 3000;

// ===== MIDDLEWARE & CONFIG =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Parse URL-encoded bodies (for the login form)
app.use(express.urlencoded({ extended: true }));

// Simple session config (in-memory store)
app.use(
  session({
    secret: 'your-secret-key-here', // in production, use a strong secret in env var
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // 'false' for HTTP; set to true if behind HTTPS
  })
);

// ===== READ USERS JSON =====
let usersData = { users: [] };

try {
  const data = fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8');
  usersData = JSON.parse(data);
} catch (err) {
  console.error('Error reading users.json:', err);
}

// ===== UTILITY: GET ZOOM ACCESS TOKEN (Server-to-Server OAuth) =====
async function getZoomAccessToken() {
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`;
  const authHeader = `Basic ${Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
  ).toString('base64')}`;

  try {
    const response = await axios.post(tokenUrl, null, {
      headers: { Authorization: authHeader },
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error fetching Zoom access token:', error.response?.data || error);
    throw error;
  }
}

// ===== FETCH LICENSED USERS =====
async function getAllLicensedUsers(accessToken) {
  try {
    const url = 'https://api.zoom.us/v2/users?page_size=300';
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const allUsers = response.data.users || [];
    // Keep only licensed (type=2) users
    return allUsers.filter(u => u.type === 2);
  } catch (error) {
    console.error('Error fetching users:', error.response?.data || error);
    throw error;
  }
}

// ===== FETCH USER MEETINGS =====
async function getUserMeetings(accessToken, userId) {
  const url = `https://api.zoom.us/v2/users/${userId}/meetings?page_size=300`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data.meetings || [];
  } catch (error) {
    console.error(`Error fetching meetings for user ${userId}:`, error.response?.data || error);
    throw error;
  }
}

// ===== GET ALL LIVE MEETINGS (ONE CALL) =====
async function getLiveMeetingsSet(accessToken) {
  const url = 'https://api.zoom.us/v2/metrics/meetings?type=live&page_size=30';
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const liveMeetings = response.data.meetings || [];

    const liveIds = new Set();
    for (const m of liveMeetings) {
      if (m.id) {
        liveIds.add(String(m.id));
      }
    }
    return liveIds;
  } catch (error) {
    console.error('Error fetching live meetings:', error.response?.data || error);
    return new Set();
  }
}

// ===== AUTH HELPER FUNCTION =====
function isAuthenticated(req) {
  return req.session && req.session.user;
}

// ===== PROTECT MIDDLEWARE =====
function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  next();
}

// ===== ROUTES =====

// (A) LOGIN PAGE (GET)
app.get('/login', (req, res) => {
  // If already authenticated, skip login
  if (isAuthenticated(req)) return res.redirect('/');
  res.render('login', { error: null });
});

// (B) LOGIN FORM (POST)
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // find user in users.json
  const userRecord = usersData.users.find(
    (u) => u.username === username && u.password === password
  );

  if (!userRecord) {
    // invalid credentials
    return res.render('login', { error: 'Invalid username or password' });
  }

  // set session
  req.session.user = { username: userRecord.username };
  return res.redirect('/');
});

// (C) LOGOUT
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    res.redirect('/login');
  });
});

// (D) MAIN ROUTE (PROTECTED) => LIST NO-FIXED-TIME MEETINGS
app.get('/', requireAuth, async (req, res) => {
  let accessToken;
  try {
    accessToken = await getZoomAccessToken();
  } catch (error) {
    return res.status(500).send('Failed to get Zoom access token.');
  }

  let licensedUsers;
  try {
    licensedUsers = await getAllLicensedUsers(accessToken);
  } catch (error) {
    return res.status(500).send('Failed to get licensed users.');
  }

  // Get set of all live meeting IDs
  const liveMeetingsSet = await getLiveMeetingsSet(accessToken);

  const usersData = [];
  for (const user of licensedUsers) {
    let allMeetings = [];
    try {
      allMeetings = await getUserMeetings(accessToken, user.id);
    } catch (error) {
      console.error(`Skipping user ${user.id} due to error fetching meetings.`);
      continue;
    }

    // Filter for "No Fixed Time" recurring meetings only: type=3
    const noFixedTimeMeetings = allMeetings
      .filter(m => m.type === 3)
      .map(m => {
        const isLive = liveMeetingsSet.has(String(m.id));
        return {
          meetingId: m.id,
          topic: m.topic,
          joinUrl: m.join_url,
          isLive,
        };
      });

    // If >=2 are live, mark user as "in use"
    const liveCount = noFixedTimeMeetings.reduce((count, m) => (m.isLive ? count + 1 : count), 0);
    const isAccountInUse = liveCount >= 2;

    usersData.push({
      userName: `${user.first_name} ${user.last_name}`.trim(),
      userEmail: user.email,
      isAccountInUse,
      recurringMeetings: noFixedTimeMeetings,
    });
  }

  // Render index.ejs (the main page listing the no-fixed-time meetings)
  res.render('index', { usersData });
});

// START SERVER
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
