# AI OSM Map Agent

Demo app that uses AI to search for places on OpenStreetMap using natural language.

## Structure

```
ai-map-agent/
├── app.py          # FastAPI backend (API + static server)
├── index.html      # Frontend HTML
├── app.js          # Map and chat logic
├── style.css       # Styles
├── requirements.txt
├── render.yaml     # Render configuration
└── .gitignore
```

## Deploy on Render

### 1. Prepare repository

```bash
cd ai-map-agent
git init
git add .
git commit -m "Initial commit"
```

Push repo to GitHub:
```bash
git remote add origin https://github.com/YOUR_USERNAME/ai-osm-map.git
git branch -M main
git push -u origin main
```

### 2. Create Web Service on Render

1. Go to [render.com](https://render.com) and login
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Configuration:
   - **Name**: `ai-osm-map` (or your choice)
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: `Free`

### 3. Configure environment variables

In the **Environment** section of your Render service, add:

- **Key**: `GROQ_API_KEY`
- **Value**: Your Groq API key (get it at [console.groq.com](https://console.groq.com))

### 4. Deploy

Click **"Create Web Service"**. Render will automatically:
- Install dependencies
- Start the server
- Give you a public URL (e.g., `https://ai-osm-map.onrender.com`)

Done! Your app will be available at the Render URL.

## Local development

```bash
# Install dependencies
pip install -r requirements.txt

# Configure API key
export GROQ_API_KEY=your_key_here

# Run
python app.py
```

Open [http://localhost:8000](http://localhost:8000)

## Usage

Write queries in natural language:
- "parks in Barcelona"
- "museums in Madrid"
- "cafes in Paris"

The agent will generate the Overpass query and display results on the map.
