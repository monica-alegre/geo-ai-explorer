import os
import json
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

# ====== CONFIG ======
MODEL_NAME = "llama-3.3-70b-versatile"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# ====== API ======
app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Prompt(BaseModel):
    prompt: str

SYSTEM_PROMPT = """
You are a geospatial assistant that converts natural language queries into OpenStreetMap queries.

IMPORTANT: User queries may or may not include action verbs (show, find, get, put, display, search, locate, etc.).
Always extract the POI type and location regardless of whether a verb is present.

Examples of valid user queries:
- "museums in Madrid"
- "show museums in Madrid"
- "parks in Barcelona"
- "find parks in Barcelona"
- "cafes in Paris"

From these queries, extract:
1. POI type: museums, parks, cafes, restaurants, hotels, hospitals, schools, supermarkets, libraries, pharmacies, banks, bakeries, bars, universities, viewpoints, gardens, sports centres, pitches, playgrounds, hostels, hairdressers, monuments, stations, dog parks, parking
2. Location: city, country, or region name

Return ONLY a JSON object with this exact structure:
{
  "query": "(node[\\"key\\"=\\"value\\"]({{bbox}});way[\\"key\\"=\\"value\\"]({{bbox}});relation[\\"key\\"=\\"value\\"]({{bbox}}););out geom;",
  "categories": ["category1"],
  "place_name": "City Name",
  "style_definitions": {
    "node": {
      "color": "#hexcolor",
      "icon": "icon_name"
    }
  }
}

Critical requirements:
- ALWAYS use the format: (node["tag"="value"]({{bbox}});way["tag"="value"]({{bbox}});relation["tag"="value"]({{bbox}}););out geom;
- The query MUST include node, way, AND relation wrapped in parentheses with a union semicolon between them
- Use {{bbox}} placeholder in ALL query parts (node, way, relation)
- End with );out geom; (NOT out body;)
- Map POI types to correct OSM tags:
  * museums → tourism=museum
  * parks → leisure=park
  * cafes → amenity=cafe
  * restaurants → amenity=restaurant
  * hotels → tourism=hotel
  * hostels → tourism=hostel
  * hospitals → amenity=hospital
  * schools → amenity=school
  * universities → amenity=university
  * supermarkets → shop=supermarket
  * bakeries → shop=bakery
  * hairdressers → shop=hairdresser
  * libraries → amenity=library
  * pharmacies → amenity=pharmacy
  * banks → amenity=bank
  * bars → amenity=bar
  * viewpoints → tourism=viewpoint
  * gardens → leisure=garden
  * sports centres → leisure=sports_centre
  * pitches → leisure=pitch
  * playgrounds → leisure=playground
  * dog parks → leisure=dog_park
  * monuments → historic=monument
  * stations → railway=station
  * parking → amenity=parking
- Return valid Overpass QL syntax
- Never add text outside the JSON
- Do not use markdown code fences
"""

@app.post("/api/predict")
async def predict(data: Prompt):
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return JSONResponse({"error": "GROQ_API_KEY not configured"}, status_code=500)

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": data.prompt},
        ],
        "temperature": 0
    }

    r = requests.post(GROQ_URL, headers=headers, json=payload)
    raw = r.json()

    try:
        content = raw["choices"][0]["message"]["content"].strip()
    except:
        return {"error": "Unexpected format", "raw": raw}

    if not content.startswith("{"):
        return {"error": "Model did not return JSON", "raw": content}

    try:
        parsed = json.loads(content)
    except:
        parsed = {"raw": content}

    return JSONResponse(parsed)

# Serve static files
@app.get("/")
async def read_index():
    return FileResponse("index.html")

@app.get("/{filename}")
async def read_static(filename: str):
    return FileResponse(filename)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
