import "dotenv/config";
import express from "express";
import WebSocket from "ws";
import fs from "fs";

const app = express();
let ws = null;
let reconnecting = false;

const loadTokens = () => {
    if (fs.existsSync("./tokens.json")) {
        try {
            const t = JSON.parse(fs.readFileSync("./tokens.json", "utf-8"));

            if (t.access_token && t.refresh_token) {
                return t;
            }
        }
        catch (err) {
            console.error("Could not read tokens.json:", err.message);
        }
    }

    return null;
}

const saveTokens = (tokens) => {
    fs.writeFileSync("./tokens.json", JSON.stringify(tokens, null, 2));
}

const refreshAccessToken = async () => {
    const tokens = loadTokens();

    if (!tokens?.refresh_token) {
        console.error("No refresh token available — need to re-auth via /callback");
        return null;
    }

    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
    });

    try {
        const resp = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params,
        });

        const data = await resp.json();

        if (!resp.ok || !data.access_token) {
            console.error("Refresh failed:", data);
            return null;
        }

        saveTokens({
            access_token: data.access_token,
            refresh_token: data.refresh_token || tokens.refresh_token,
        });

        console.log("Token refreshed");
        return data.access_token;
    }
    catch (err) {
        console.error("Refresh request failed:", err);
        return null;
    }
}

const sendMessage = (channel, text) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("Cannot send message — WebSocket not open");
        return;
    }

    ws.send(`PRIVMSG #${channel} :${text}`);
}

const loadCopypasta = () => {
    try {
        return fs.readFileSync("./copypasta.txt", "utf-8").trim();
    } catch (err) {
        console.error("Could not read copypasta.txt:", err.message);
        return null;
    }
}

const updateCopypasta = (text) => {
    try {
        fs.writeFileSync("./copypasta.txt", text);
        return true;
    }
    catch (err) {
        return false;
    }
};

const handleCommand = (cmd, args, username, channel, perms) => {
    if (cmd === "copypasta" && !perms.isMod && !perms.isVip && !perms.isBroadcaster) {
        return;
    }

    switch (cmd) {
        case "copypasta": {
            let text = loadCopypasta();

            if (!text) return;

            if (args[0] === "add" && args.length > 1) {
                text += ` ${args[1]}`;
                const res = updateCopypasta(text);
                sendMessage(channel, res ? "Word added uwu <3" : "Idk what happened but it didnt work lol");
                return;
            }
            
            let remaining = text.trim();

            while (remaining.length > 500) {
                const index = remaining.lastIndexOf(" ", 500);

                if (index === -1) {
                    sendMessage(channel, remaining.slice(0, 500));
                    remaining = remaining.slice(500);
                    continue;
                }

                sendMessage(channel, remaining.slice(0, index));
                remaining = remaining.slice(index + 1);
            }

            if (remaining) {
                sendMessage(channel, remaining);
            }
        }
    }
};

const parseTags = (tagString) => {
    const tags = {};

    if (!tagString) return tags;

    for (const pair of tagString.split(";")) {
        const separator = pair.indexOf("=");

        if (separator === -1) {
            tags[pair] = "";
            continue;
        }

        const key = pair.slice(0, separator);
        const value = pair.slice(separator + 1);

        tags[key] = value;
    }

    return tags;
}

const connectToTwitch = (token) => {
    if (!token) {
        console.error("No valid token — visit the auth URL to authorize the bot first.");
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        return;
    }

    ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

    ws.on("open", () => {
        console.log("Connected to Twitch");
        reconnecting = false;

        ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        ws.send(`PASS oauth:${token}`);
        ws.send(`NICK ${process.env.TWITCH_BOT_USERNAME.toLowerCase()}`);
        ws.send(`JOIN #${process.env.TWITCH_CHANNEL.toLowerCase()}`);
    });

    ws.on("message", (data) => {
        const raw = data.toString();
        const lines = raw.split("\r\n").filter(Boolean);

        for (const line of lines) {
            if (line.startsWith("PING")) {
                ws.send(`PONG ${line.slice(5)}`);
                continue;
            }

            if (line.includes("Login authentication failed")) {
                console.error("Twitch login authentication failed.");
                continue;
            }

            if (!line.includes("PRIVMSG")) continue;

            let tags = {};

            if (line.startsWith("@")) {
                const tagEnd = line.indexOf(" :");

                if (tagEnd !== -1) {
                    const tagPart = line.slice(1, tagEnd);
                    tags = parseTags(tagPart);
                }
            }

            const match = line.match(/PRIVMSG #(\S+) :([\s\S]*)$/);

            if (!match) continue;

            const channel = match[1];
            const message = match[2];

            const username = tags["login"] || tags["display-name"] || "unknown";

            const badges = tags["badges"] || "";

            const isMod =
                tags["mod"] === "1" ||
                badges.includes("moderator/1");

            const isVip = badges.includes("vip/1");
            const isBroadcaster = badges.includes("broadcaster/1");

            console.log(`${username}: ${message}`);

            if (!message.startsWith("!")) continue;

            const parts = message.slice(1).trim().split(/\s+/);

            if (!parts[0]) continue;

            const command = parts.shift().toLowerCase();
            const args = parts;

            handleCommand(command, args, username, channel, {
                isMod,
                isVip,
                isBroadcaster,
            });
        }
    });

    ws.on("close", async (code, reason) => {
        console.log("Twitch closed:", code, reason.toString());

        ws = null;

        if (reconnecting) return;

        reconnecting = true;

        try {
            const newToken = await refreshAccessToken();

            if (newToken) {
                reconnecting = false;
                connectToTwitch(newToken);
            } else {
                reconnecting = false;
                console.error("Could not reconnect — re-authorize via /callback.");
            }
        }
        catch (err) {
            reconnecting = false;
            console.error("Error during reconnect attempt:", err);
        }
    });

    ws.on("error", (err) => {
        console.error("WebSocket error:", err);
    });
}

app.get("/callback", async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
        console.error("Twitch auth error:", error, error_description);
        return res.status(400).send(`Auth failed: ${error_description}`);
    }

    if (!code) {
        return res.status(400).send("No authorization code received.");
    }

    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: process.env.CALLBACK_URL,
    });

    try {
        const resp = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params,
        });

        const data = await resp.json();

        if (!resp.ok || !data.access_token) {
            console.error("Token exchange failed:", data);
            return res.status(400).send(`Token exchange failed: ${JSON.stringify(data)}`);
        }

        saveTokens({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
        });

        console.log("OAuth successful.");

        connectToTwitch(data.access_token);

        res.send("Authorized! Bot connecting to Twitch.");
    }
    catch (err) {
        console.error("OAuth request failed:", err);
        res.status(500).send("OAuth request failed.");
    }
});

app.get("/", (req, res) => {
    res.send("Twitch bot is running");
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server running");

    const tokens = loadTokens();

    if (tokens) {
        connectToTwitch(tokens.access_token);
    }
    else {
        console.log("No tokens found — visit the auth URL to authorize.");
    }
});