require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const session = require('express-session');

const app = express();
const port = process.env.PORT || 3000;

// ===== MIDDLEWARE & CONFIG =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Parse URL-encoded bodies (for login form)
app.use(express.urlencoded({ extended: true }));

// Session config (in-memory) — in production, use a better store
app.use(
  session({
    secret: 'your-secret-key-here', // or from process.env
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // set to true if behind HTTPS
  })
);

// ===== ZOOM TOKEN (Server-to-Server OAuth) =====
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
    // Only licensed (type=2)
    return allUsers.filter((u) => u.type === 2);
  } catch (error) {
    console.error('Error fetching users:', error.response?.data || error);
    throw error;
  }
}

// ===== FETCH MEETINGS FOR A USER =====
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

// ===== LIST LIVE MEETINGS (ONE CALL) =====
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

// ===== AUTH CHECK =====
function isAuthenticated(req) {
  return req.session && req.session.user;
}

// ===== MIDDLEWARE: REQUIRE LOGIN =====
function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  next();
}

// ===== ROUTES =====

// (A) GET /LOGIN => Show Login Page
app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.render('login', { error: null });
});

// (B) POST /LOGIN => Check Credentials
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Compare with env vars
  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    // Valid
    req.session.user = { username: username };
    return res.redirect('/');
  } else {
    // Invalid
    return res.render('login', { error: 'Invalid username or password' });
  }
});

// (C) GET /LOGOUT => End Session
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    res.redirect('/login');
  });
});

// (D) GET / => Protected Zoom Meetings Page
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

  // One call for all live meeting IDs
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

    // Only "No Fixed Time" => type=3
    const noFixedTimeMeetings = allMeetings
      .filter((m) => m.type === 3)
      .map((m) => {
        const isLive = liveMeetingsSet.has(String(m.id));
        return {
          meetingId: m.id,
          topic: m.topic,
          joinUrl: m.join_url,
          isLive,
        };
      });

    // Mark user as in use if >=2 are live
    const liveCount = noFixedTimeMeetings.reduce(
      (count, m) => (m.isLive ? count + 1 : count),
      0
    );
    const isAccountInUse = liveCount >= 2;

    usersData.push({
      userName: `${user.first_name} ${user.last_name}`.trim(),
      userEmail: user.email,
      isAccountInUse,
      recurringMeetings: noFixedTimeMeetings,
    });
  }

  res.render('index', { usersData });
});

// START SERVER
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
