// === Minimal grey basemap ===
const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [0, 20], // initial center (Barcelona)
  zoom: 1.5,
  pitch: 0
});

// Store layers with their markers and metadata
let layers = {}; // { layerId: { markers: [], name: "", category: "", color: "" } }

// --- Chat display ---
function addMessage(sender, text) {
  const chat = document.getElementById("chat");

  const msg = document.createElement("div");
  msg.textContent = `${sender}: ${text}`;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

// --- Call AI backend ---
async function getAIQuery(prompt) {
  const res = await fetch(window.location.origin + "/api/predict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt })
  });
  if (!res.ok) {
    throw new Error("AI backend error");
  }
  return res.json();
}

// --- Get bounding box from place name using Nominatim ---
async function getBboxFromPlace(placeName) {
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(placeName)}&format=json&limit=1`;
  const res = await fetch(nominatimUrl, {
    headers: { 'User-Agent': 'AI-Map-Agent' }
  });
  if (!res.ok) {
    throw new Error("Nominatim API error");
  }
  const data = await res.json();
  if (data.length === 0) {
    throw new Error(`Place "${placeName}" not found`);
  }

  const bbox = data[0].boundingbox; // [minlat, maxlat, minlon, maxlon]
  const center = [parseFloat(data[0].lon), parseFloat(data[0].lat)];

  return {
    bbox: `${bbox[0]},${bbox[2]},${bbox[1]},${bbox[3]}`, // Overpass format: minlat,minlon,maxlat,maxlon
    center: center
  };
}

// --- Call Overpass ---
async function fetchOverpass(query) {
  const overpassUrl = "https://overpass-api.de/api/interpreter";

  // Build proper Overpass query with geometry resolution
  let fullQuery = query.trim();

  // Add [out:json] with timeout if not present
  if (!fullQuery.startsWith('[out:json]')) {
    fullQuery = '[out:json][timeout:25];' + fullQuery;
  } else if (!fullQuery.includes('[timeout:')) {
    fullQuery = fullQuery.replace('[out:json]', '[out:json][timeout:25]');
  }

  // Replace simple 'out body;' with 'out geom;' to get full geometry for ways/relations
  // Add result limit to prevent timeouts
  fullQuery = fullQuery.replace(/;out body;?$/g, ';out geom;');

  // Add result limit if not present (limit to 500 results)
  if (!fullQuery.match(/\);\s*\)/)) {
    fullQuery = fullQuery.replace(/\);$/, ');out geom 500;');
  }

  console.log("Final Overpass Query:", fullQuery);

  const res = await fetch(overpassUrl, { method: "POST", body: fullQuery });
  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  console.log("Overpass Response (elements):", json.elements?.length || 0);

  // Log first element to debug
  if (json.elements && json.elements.length > 0) {
    console.log("First element sample:", json.elements[0]);
  }

  const geojson = osmtogeojson(json);
  console.log("GeoJSON (features):", geojson.features?.length || 0);

  // Log first feature to debug
  if (geojson.features && geojson.features.length > 0) {
    console.log("First feature sample:", geojson.features[0]);
  } else {
    console.error("osmtogeojson failed to convert! Raw data:", json);
  }

  return geojson;
}

// --- Helper: clear all layers ---
function clearAllLayers() {
  Object.values(layers).forEach(layer => {
    layer.markers.forEach(m => m.remove());
  });
  layers = {};
  updateLegend();
}

// --- Helper: remove specific layer ---
function removeLayer(layerId) {
  if (layers[layerId]) {
    layers[layerId].markers.forEach(m => m.remove());
    delete layers[layerId];
    updateLegend();
  }
}

// --- Helper: remove all layers of a specific category ---
function removeCategoryLayers(category) {
  const layerIdsToRemove = [];

  Object.entries(layers).forEach(([layerId, layer]) => {
    if (layer.category === category) {
      layer.markers.forEach(m => m.remove());
      layerIdsToRemove.push(layerId);
    }
  });

  layerIdsToRemove.forEach(id => delete layers[id]);
  updateLegend();
}

// --- Helper: get category from OSM tags ---
function getCategoryFromTags(tags) {
  if (!tags) return "poi";

  // Tourism
  if (tags.tourism === "museum") return "museum";
  if (tags.tourism === "hotel") return "hotel";
  if (tags.tourism === "hostel") return "hostel";
  if (tags.tourism === "viewpoint") return "viewpoint";

  // Amenities
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "restaurant") return "restaurant";
  if (tags.amenity === "hospital") return "hospital";
  if (tags.amenity === "school") return "school";
  if (tags.amenity === "pharmacy") return "pharmacy";
  if (tags.amenity === "library") return "library";
  if (tags.amenity === "bank") return "bank";
  if (tags.amenity === "bar") return "bar";
  if (tags.amenity === "university") return "university";
  if (tags.amenity === "parking") return "parking";

  // Shops
  if (tags.shop === "supermarket") return "supermarket";
  if (tags.shop === "bakery") return "bakery";
  if (tags.shop === "hairdresser") return "hairdresser";

  // Leisure
  if (tags.leisure === "park") return "park";
  if (tags.leisure === "garden") return "garden";
  if (tags.leisure === "sports_centre") return "sports_centre";
  if (tags.leisure === "pitch") return "pitch";
  if (tags.leisure === "playground") return "playground";
  if (tags.leisure === "dog_park") return "dog_park";

  // Historic
  if (tags.historic === "monument") return "monument";

  // Railway
  if (tags.railway === "station") return "station";

  return "poi";
}

// --- Category definitions with colors and labels ---
const CATEGORIES = {
  restaurant: { color: "#E76F51", label: "Restaurants", tags: ["amenity=restaurant"] },
  cafe: { color: "#F4A261", label: "Cafes", tags: ["amenity=cafe"] },
  bar: { color: "#E63946", label: "Bars", tags: ["amenity=bar"] },
  bakery: { color: "#C19A6B", label: "Bakeries", tags: ["shop=bakery"] },
  school: { color: "#3A86FF", label: "Schools", tags: ["amenity=school"] },
  university: { color: "#0077B6", label: "Universities", tags: ["amenity=university"] },
  library: { color: "#6B5B95", label: "Libraries", tags: ["amenity=library"] },
  museum: { color: "#9D4EDD", label: "Museums", tags: ["tourism=museum"] },
  monument: { color: "#9B59B6", label: "Monuments", tags: ["historic=monument"] },
  viewpoint: { color: "#48CAE4", label: "Viewpoints", tags: ["tourism=viewpoint"] },
  park: { color: "#2A9D8F", label: "Parks", tags: ["leisure=park"] },
  garden: { color: "#52B788", label: "Gardens", tags: ["leisure=garden"] },
  dog_park: { color: "#95D5B2", label: "Dog Parks", tags: ["leisure=dog_park"] },
  playground: { color: "#FFC300", label: "Playgrounds", tags: ["leisure=playground"] },
  sports_centre: { color: "#E63946", label: "Sports", tags: ["leisure=sports_centre"] },
  pitch: { color: "#7FFFD4", label: "Pitches", tags: ["leisure=pitch"] },
  hospital: { color: "#E85D75", label: "Hospitals", tags: ["amenity=hospital"] },
  pharmacy: { color: "#06D6A0", label: "Pharmacies", tags: ["amenity=pharmacy"] },
  bank: { color: "#FFB703", label: "Banks", tags: ["amenity=bank"] },
  supermarket: { color: "#8338EC", label: "Supermarkets", tags: ["shop=supermarket"] },
  hairdresser: { color: "#F72585", label: "Hairdressers", tags: ["shop=hairdresser"] },  
  hotel: { color: "#FB5607", label: "Hotels", tags: ["tourism=hotel"] },
  hostel: { color: "#F77F00", label: "Hostels", tags: ["tourism=hostel"] },
  station: { color: "#2C3E50", label: "Stations", tags: ["railway=station"] },  
  parking: { color: "#6C757D", label: "Parking", tags: ["amenity=parking"] },
  poi: { color: "#ADB5BD", label: "Other POIs", tags: [] }
};

// Legacy color map for backward compatibility
const CATEGORY_COLORS = Object.fromEntries(
  Object.entries(CATEGORIES).map(([key, val]) => [key, val.color])
);

// --- Helper: create minimal SVG icon by category (black & white) ---
function createSVGIcon(category) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.poi;
  return createSVGIconWithColor(category, color);
}

// --- Helper: create SVG icon with custom color ---
function createSVGIconWithColor(category, color) {
  const div = document.createElement("div");
  div.className = "poi-marker";

  // Unique flat color icons for each category
  let svg = "";

  switch (category) {
    case "restaurant":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <line x1="12" y1="8" x2="12" y2="24" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
          <line x1="12" y1="8" x2="12" y2="14" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M9 8 v6 q0 2 3 2" fill="none" stroke="${color}" stroke-width="2"/>
          <path d="M15 8 v6 q0 2 -3 2" fill="none" stroke="${color}" stroke-width="2"/>
          <path d="M20 8 v4 q0 2 2 2 v10" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
        </svg>`;
      break;
    case "cafe":
      svg = `
       <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(4, 4)" fill="${color}">
            <g transform="matrix(1 0 0 1 12 12)">
              <path d="M 9 2 C 9 3.277344 8.78125 3.28125 8.28125 3.78125 C 7.78125 4.28125 7 5.277344 7 7 L 9 7 C 9 5.722656 9.21875 5.71875 9.71875 5.21875 C 10.21875 4.71875 11 3.722656 11 2 Z M 12.6875 3 C 12.6875 5.398438 11 5.398438 11 7 L 13 7 C 13 5.5 14.6875 5.699219 14.6875 3 Z M 3 8 L 4.8125 20.3125 C 4.914063 21.3125 5.8125 22 6.8125 22 L 13.3125 22 C 14.3125 22 15.113281 21.3125 15.3125 20.3125 L 15.90625 16 L 17.40625 16 C 18.859375 16 20.199219 14.957031 20.375 13.4375 C 20.375 13.429688 20.367188 13.410156 20.375 13.40625 L 20.6875 11.4375 L 20.6875 11.375 C 20.832031 9.628906 19.5 8 17.6875 8 Z M 16.71875 10 L 17.6875 10 C 18.257813 10 18.738281 10.53125 18.71875 11.15625 C 18.71875 11.179688 18.71875 11.195313 18.71875 11.21875 L 18.40625 13.15625 L 18.40625 13.1875 C 18.359375 13.640625 17.941406 14 17.40625 14 L 16.1875 14 Z" transform=" translate(-11.85, -12)" stroke-linecap="round" />
            </g>
          </g>
        </svg>`;
      break;
    case "bar":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 7)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}">
              <g transform="matrix(0.87 0 0 0.87 12 12)">
                <path d="M 8 4 C 7.526 4 7.1184844 4.332875 7.0214844 4.796875 C 6.9794844 4.996875 6 9.715 6 12 C 6 16.623417 9.5075863 20.441451 14 20.941406 L 14 24.195312 L 9.8242188 25.013672 C 9.805229531137265 25.01703143730781 9.786341400593907 25.02093940457936 9.7675781 25.025391 L 9.7382812 25.03125 L 9.7382812 25.033203 C 9.251657662333823 25.16219811031299 8.93677228270921 25.632802327849166 9.003177686524374 26.13183391827161 C 9.069583090339538 26.63086550869405 9.496577067164631 27.002748925397814 10 27 L 20 27 C 20.506395993792996 27.006698610550917 20.93786928833498 26.633801808586053 21.004606643431206 26.13177800501926 C 21.071343998527432 25.62975420145247 20.752277644465696 25.157083184227712 20.261719 25.03125 L 20.234375 25.025391 C 20.207905981900005 25.019095587834215 20.18119109079239 25.01388291801783 20.154297 25.009766 L 16 24.195312 L 16 20.941406 C 20.492414 20.441451 24 16.623417 24 12 C 24 9.709 23.020516 4.9949219 22.978516 4.7949219 C 22.881516 4.3319219 22.474 4 22 4 L 8 4 z M 8.8203125 6 L 21.179688 6 C 21.319688 6.726 21.529172 7.858 21.701172 9 L 10.289062 9 C 10.126063 10.106 10 11.216 10 12 C 10 13.292 10.307563 14.511844 10.851562 15.589844 C 11.260563 16.400844 10.159984 17.125828 9.5839844 16.423828 C 8.5949844 15.218828 8 13.679 8 12 C 8 10.443 8.5423125 7.433 8.8203125 6 z" transform=" translate(-15, -15.5)"/>
              </g>
            </svg>
          </g>
        </svg>`;
      break;
    case "bakery":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 30 30" fill="${color}">
              <path d="M 15 5 C 10.313 5 7.5593594 6.8058125 7.4433594 6.8828125 C 7.0373594 7.1538125 6.8888437 7.6809531 7.0898438 8.1269531 L 11.736328 18.412109 C 11.898328 18.770109 12.256437 19 12.648438 19 L 17.351562 19 C 17.744563 19 18.099719 18.770109 18.261719 18.412109 L 22.910156 8.1269531 C 23.112156 7.6809531 22.962641 7.1538125 22.556641 6.8828125 C 22.440641 6.8058125 19.687 5 15 5 z M 5.9296875 10.419922 C 4.4336875 11.593922 2.8237344 13.301797 2.0527344 15.591797 C 1.9487344 15.899797 2.0013125 16.238953 2.1953125 16.501953 C 2.2833125 16.620953 3.1186406 17.696344 5.4316406 18.777344 C 7.3186406 19.659344 9.0295625 19.971375 9.1015625 19.984375 C 9.1595625 19.995375 9.2183438 20 9.2773438 20 C 9.6323438 20 9.8939063 19.847953 10.128906 19.626953 C 10.048906 19.503953 9.9780156 19.374281 9.9160156 19.238281 L 5.9296875 10.419922 z M 24.070312 10.419922 L 20.083984 19.238281 C 20.021984 19.374281 19.951094 19.503953 19.871094 19.626953 C 20.106094 19.847953 20.367656 20 20.722656 20 C 20.781656 20 20.840438 19.995375 20.898438 19.984375 C 20.970437 19.971375 22.681359 19.659344 24.568359 18.777344 C 26.881359 17.696344 27.716688 16.620953 27.804688 16.501953 C 27.998688 16.238953 28.051266 15.899797 27.947266 15.591797 C 27.176266 13.301797 25.566312 11.593922 24.070312 10.419922 z M 2.0039062 19.050781 C 2.0199063 23.022781 3.836 25 5 25 C 6.139 25 6.7100938 23.565453 7.6210938 21.689453 C 6.8440937 21.480453 5.7489844 21.133844 4.5839844 20.589844 C 3.4549844 20.061844 2.6229062 19.525781 2.0039062 19.050781 z M 27.996094 19.050781 C 27.377094 19.525781 26.545016 20.061844 25.416016 20.589844 C 24.251016 21.133844 23.155906 21.480453 22.378906 21.689453 C 23.289906 23.565453 23.861 25 25 25 C 26.164 25 27.980094 23.022781 27.996094 19.050781 z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "school":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}">
              <path d="M 12 1.9550781 L 1.7128906 5.0429688 L 2.2871094 6.9570312 L 12 4.0449219 L 21.712891 6.9570312 L 22.287109 5.0429688 L 12 1.9550781 z M 2 9 L 2 20 C 9 20 12 23 12 23 C 12 23 15 20 22 20 L 22 9 C 15 9 12 12 12 12 C 12 12 9 9 2 9 z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "university":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}">
              <path d="M11.7 2.805a.75.75 0 0 1 .6 0A60.65 60.65 0 0 1 22.83 8.72a.75.75 0 0 1-.231 1.337 49.948 49.948 0 0 0-9.902 3.912l-.003.002c-.114.06-.227.119-.34.18a.75.75 0 0 1-.707 0A50.88 50.88 0 0 0 7.5 12.173v-.224c0-.131.067-.248.172-.311a54.615 54.615 0 0 1 4.653-2.52.75.75 0 0 0-.65-1.352 56.123 56.123 0 0 0-4.78 2.589 1.858 1.858 0 0 0-.859 1.228 49.803 49.803 0 0 0-4.634-1.527.75.75 0 0 1-.231-1.337A60.653 60.653 0 0 1 11.7 2.805Z" />
              <path d="M13.06 15.473a48.45 48.45 0 0 1 7.666-3.282c.134 1.414.22 2.843.255 4.284a.75.75 0 0 1-.46.711 47.87 47.87 0 0 0-8.105 4.342.75.75 0 0 1-.832 0 47.87 47.87 0 0 0-8.104-4.342.75.75 0 0 1-.461-.71c.035-1.442.121-2.87.255-4.286.921.304 1.83.634 2.726.99v1.27a1.5 1.5 0 0 0-.14 2.508c-.09.38-.222.753-.397 1.11.452.213.901.434 1.346.66a6.727 6.727 0 0 0 .551-1.607 1.5 1.5 0 0 0 .14-2.67v-.645a48.549 48.549 0 0 1 3.44 1.667 2.25 2.25 0 0 0 2.12 0Z" />
              <path d="M4.462 19.462c.42-.419.753-.89 1-1.395.453.214.902.435 1.347.662a6.742 6.742 0 0 1-1.286 1.794.75.75 0 0 1-1.06-1.06Z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "library":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}">
              <path d="M11.25 4.533A9.707 9.707 0 0 0 6 3a9.735 9.735 0 0 0-3.25.555.75.75 0 0 0-.5.707v14.25a.75.75 0 0 0 1 .707A8.237 8.237 0 0 1 6 18.75c1.995 0 3.823.707 5.25 1.886V4.533ZM12.75 20.636A8.214 8.214 0 0 1 18 18.75c.966 0 1.89.166 2.75.47a.75.75 0 0 0 1-.708V4.262a.75.75 0 0 0-.5-.707A9.735 9.735 0 0 0 18 3a9.707 9.707 0 0 0-5.25 1.533v16.103Z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "museum":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 50 50" fill="${color}">
              <path d="M 25 1.9980469 C 24.8425 1.9980469 24.684062 2.034375 24.539062 2.109375 L 3.5390625 13.109375 C 3.2090625 13.289375 3 13.63 3 14 L 3 16 L 47 16 L 47 14 C 47 13.63 46.790937 13.289375 46.460938 13.109375 L 25.460938 2.109375 C 25.315938 2.034375 25.1575 1.9980469 25 1.9980469 z M 5 18 L 5 19.400391 C 5 20.650391 5.84 21.669687 7 21.929688 L 7 38 L 15 38 L 15 21.929688 C 16.16 21.669688 17 20.650391 17 19.400391 L 17 18 L 5 18 z M 19 18 L 19 19.400391 C 19 20.650391 19.84 21.669687 21 21.929688 L 21 38 L 29 38 L 29 21.929688 C 30.16 21.669688 31 20.650391 31 19.400391 L 31 18 L 19 18 z M 33 18 L 33 19.400391 C 33 20.650391 33.84 21.669687 35 21.929688 L 35 38 L 43 38 L 43 21.929688 C 44.16 21.669688 45 20.650391 45 19.400391 L 45 18 L 33 18 z M 4 40 C 3.56 40 3.0707031 40.159219 2.7207031 40.449219 C 2.2607031 40.839219 2 41.419297 2 42.029297 L 2 44.779297 C 2 46.019297 2.9196094 47 4.0996094 47 L 45.800781 47 C 46.960781 47 47.900391 46.050859 47.900391 44.880859 L 47.900391 42.130859 C 47.900391 40.960859 46.960781 40.009766 45.800781 40.009766 C 45.800781 40.009766 4.08 40 4 40 z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "monument":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(4, 4)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}">
              <path d="M 15 3 C 13.895 3 13 3.895 13 5 C 13 6.105 13.895 7 15 7 C 16.105 7 17 6.105 17 5 C 17 3.895 16.105 3 15 3 z M 15 7 L 12.949 7 C 12.424 7 12 7.424 12 7.949 L 12 8.518 C 12 8.804 12.136 9.067 12.352 9.254 C 12.64 9.503 13 9.928 13 10.5 C 13 11.453 12 18 12 18 L 15 18 L 18 18 C 18 18 17 11.453 17 10.5 C 17 9.928 17.36 9.503 17.648 9.254 C 17.864 9.067 18 8.804 18 8.518 L 18 7.949 C 18 7.424 17.576 7 17.051 7 L 15 7 z M 11 20 C 10.448 20 10 20.448 10 21 C 10 21.484 10.352 21.869 10.809 21.961 L 10.199 25 L 10 25 C 9.448 25 9 25.448 9 26 C 9 26.552 9.448 27 10 27 L 20 27 C 20.552 27 21 26.552 21 26 C 21 25.448 20.552 25 20 25 L 19.801 25 L 19.191 21.961 C 19.648 21.869 20 21.484 20 21 C 20 20.448 19.552 20 19 20 L 11 20 z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "viewpoint":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <circle cx="16" cy="16" r="8" fill="none" stroke="${color}" stroke-width="2.5"/>
          <circle cx="16" cy="16" r="3" fill="${color}"/>
          <line x1="16" y1="6" x2="16" y2="9" stroke="${color}" stroke-width="2"/>
          <line x1="16" y1="23" x2="16" y2="26" stroke="${color}" stroke-width="2"/>
          <line x1="6" y1="16" x2="9" y2="16" stroke="${color}" stroke-width="2"/>
          <line x1="23" y1="16" x2="26" y2="16" stroke="${color}" stroke-width="2"/>
        </svg>`;
      break;
    case "park":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <circle cx="16" cy="12" r="6" fill="${color}"/>
          <circle cx="12" cy="14" r="4" fill="${color}" opacity="0.7"/>
          <circle cx="20" cy="14" r="4" fill="${color}" opacity="0.7"/>
          <rect x="14.5" y="18" width="3" height="8" fill="${color}"/>
          <rect x="10" y="25" width="12" height="1.5" rx="0.5" fill="${color}"/>
        </svg>`;
      break;
    case "garden":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <circle cx="16" cy="14" r="4" fill="${color}"/>
          <circle cx="11" cy="17" r="3" fill="${color}" opacity="0.8"/>
          <circle cx="21" cy="17" r="3" fill="${color}" opacity="0.8"/>
          <circle cx="14" cy="20" r="2.5" fill="${color}" opacity="0.6"/>
          <circle cx="18" cy="20" r="2.5" fill="${color}" opacity="0.6"/>
        </svg>`;
      break;
    case "dog_park":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(4, 4)">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="${color}">
              <g transform="matrix(0.8 0 0 0.8 12 12)">
                <path d="M 26.5 3 C 25.67157287525381 3 25 3.6715728752538097 25 4.5 C 25 5.32842712474619 25.67157287525381 6 26.5 6 C 27.32842712474619 6 28 5.32842712474619 28 4.5 C 28 3.6715728752538097 27.32842712474619 3 26.5 3 z M 19.367188 3.0097656 C 19.149188 2.9923906 18.926109 3.035625 18.724609 3.140625 L 17.353516 3.8515625 C 16.208516 3.2425625 14.568359 3.6132813 14.568359 3.6132812 L 16 6 L 14.894531 9.3535156 L 6.90625 13.580078 L 5.3164062 13.050781 C 5.22202944101666 13.018021901782909 5.123276977171833 12.999588273923406 5.0234375 12.996094 C 4.522829203129339 12.976543941738178 4.084996767793936 13.330416909914158 3.999114924319356 13.823990795604225 C 3.9132330808447753 14.317564681294293 4.205804054276419 14.798527823897413 4.683593799999999 14.949219 L 6.0214844 15.394531 L 6.125 18.349609 L 6.0722656 18.572266 L 3.7695312 21.6875 C 3.707107952159094 21.77179655113357 3.658334674226801 21.865388633637927 3.625 21.964844 L 3.0507812 23.683594 C 2.876149774942286 24.207798341596657 3.1594766771323317 24.774326291101385 3.683650064517535 24.94905060630564 C 4.207823451902739 25.12377492150989 4.774401600135981 24.840548416713414 4.9492188 24.316406 L 5.4707031 22.748047 L 6.5761719 21.251953 L 8.1621094 19.572266 L 8.3691406 21.523438 L 6.7695312 23.6875 C 6.707107952159094 23.77179655113357 6.6583346742268015 23.865388633637924 6.625 23.964844 L 6.0507812 25.683594 C 5.937666766944563 26.022737244215758 6.014098620880747 26.396465015404544 6.251279673430034 26.66396859178111 C 6.488460725979321 26.93147216815768 6.8503486503475175 27.05210137461423 7.200595601958574 26.980406967930005 C 7.550842553569631 26.908712561245775 7.836224571432768 26.655589312344723 7.9492188 26.316406 L 8.4707031 24.748047 L 10.804688 21.59375 C 10.814883357165288 21.578397907049744 10.824652420950367 21.56276693814868 10.833984 21.546875 L 10.865234 21.53125 L 12.632812 17.96875 L 17.994141 15.259766 L 21.478516 15.988281 L 21.482422 15.982422 C 21.54102386771879 15.993570247038965 21.60050565936081 15.99945303217565 21.660156 16 L 24.662109 16 L 25.591797 16.416016 C 25.918033741457222 16.561986144976448 26.297368280395595 16.522782142240803 26.586856542312336 16.31317717828838 C 26.87634480422908 16.103572214335962 27.03198738366441 15.755424208842891 26.99513371710024 15.399925260937488 C 26.95828005053607 15.044426313032083 26.734531537514826 14.735608811612774 26.408203 14.589844 L 25.283203 14.087891 C 25.154835107895074 14.03019871629993 25.01573611229404 14.000249034836612 24.875 14 L 21.962891 14 L 20.029297 12.396484 L 21.349609 12.195312 C 21.437157584884957 12.181924471835355 21.522539967796682 12.156966870450036 21.603516 12.121094 L 24.132812 11 L 25 11 C 25.360635916577568 11.005100289545485 25.696081364571608 10.815624703830668 25.877887721486516 10.504127150285669 C 26.059694078401428 10.192629596740671 26.059694078401428 9.80737040325933 25.877887721486516 9.495872849714331 C 25.696081364571608 9.184375296169332 25.360635916577568 8.994899710454515 25 9 L 23.921875 9 C 23.78193732850878 8.999908353712916 23.64353797773784 9.029185139452922 23.515625 9.0859375 L 20.914062 10.238281 L 20.878906 10.244141 L 19.439453 10 L 19.992188 7.4355469 L 22.257812 6.5683594 C 22.704812 6.3973594 23 5.9682344 23 5.4902344 L 23 4.4023438 C 23 4.0253438 22.693406 3.71875 22.316406 3.71875 L 20.626953 3.71875 L 19.980469 3.2402344 C 19.797969 3.1047344 19.585187 3.0271406 19.367188 3.0097656 z" transform=" translate(-15.5, -15)"/>
              </g>
            </svg>
          </g>
        </svg>`;
      break;
    case "playground":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 50 50" fill="${color}">
              <path d="M 13.5 4 C 13.2155 4 12.930141 4.0811875 12.681641 4.2421875 L 2.6816406 10.742188 C 2.2566406 11.019187 2 11.492 2 12 L 2 27.5 L 2 33.253906 C 1.97354828592323 33.414936288155594 1.97354828592323 33.57920371184441 2 33.740234 L 2 39.253906 C 1.97354828592323 39.414936288155594 1.97354828592323 39.57920371184441 2 39.740234 L 2 42.5 C 1.9923495656817682 43.040953874866354 2.2765629442539925 43.54412204685742 2.743809274571493 43.81683158222979 C 3.211055604888993 44.08954111760215 3.788944395111008 44.08954111760215 4.2561907254285085 43.81683158222978 C 4.723437055746008 43.54412204685742 5.007650434318232 43.040953874866354 5 42.5 L 5 41 L 22 41 L 22 42.5 C 21.992349565681767 43.040953874866354 22.276562944253993 43.54412204685742 22.743809274571493 43.81683158222979 C 23.211055604888994 44.08954111760215 23.78894439511101 44.08954111760215 24.256190725428507 43.81683158222978 C 24.723437055746007 43.54412204685742 25.007650434318233 43.040953874866354 25 42.5 L 25 39.746094 C 25.02645171407677 39.585063711844406 25.02645171407677 39.42079628815559 25 39.259766 L 25 33.746094 C 25.02645171407677 33.585063711844406 25.02645171407677 33.42079628815559 25 33.259766 L 25 27.5 L 25 12 C 25 11.492 24.742406 11.019188 24.316406 10.742188 L 14.316406 4.2421875 C 14.067906 4.0811875 13.7845 4 13.5 4 z M 13.5 13 C 15.986 13 18 15.014 18 17.5 C 18 19.986 15.986 22 13.5 22 C 11.014 22 9 19.986 9 17.5 C 9 15.014 11.014 13 13.5 13 z M 27 17.361328 L 27 27.716797 C 29.739 28.975797 31.258359 31.756516 32.943359 34.853516 C 35.275359 39.141516 37.919 44 44.5 44 C 45.329 44 46 43.328 46 42.5 L 46 38.5 C 46 37.739 45.431781 37.100719 44.675781 37.011719 C 41.927781 36.687719 40.493031 33.478719 38.832031 29.761719 C 36.629031 24.830719 33.951 18.861328 27 17.361328 z M 5 29 L 22 29 L 22 32 L 5 32 L 5 29 z M 5 35 L 22 35 L 22 38 L 5 38 L 5 35 z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "sports_centre":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(8, 8)">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="${color}">
              <path d="M 12.6 2.21 C 12.226 1.809 11.663 1.644 11.131 1.779 C 10.6 1.915 10.185 2.33 10.049 2.861 C 9.914 3.393 10.079 3.956 10.48 4.33 L 13.31 7.16 C 13.501 7.354 13.501 7.666 13.31 7.86 L 7.86 13.31 C 7.769 13.407 7.643 13.462 7.51 13.462 C 7.377 13.462 7.251 13.407 7.16 13.31 L 4.33 10.48 C 3.742 9.895 2.79 9.897 2.205 10.485 C 1.62 11.073 1.622 12.025 2.21 12.61 L 11.4 21.8 C 11.988 22.379 12.932 22.379 13.52 21.8 C 13.803 21.52 13.963 21.138 13.963 20.74 C 13.963 20.342 13.803 19.96 13.52 19.68 L 10.69 16.85 C 10.498 16.652 10.498 16.338 10.69 16.14 L 16.14 10.69 C 16.337 10.505 16.643 10.505 16.84 10.69 L 19.67 13.52 C 20.044 13.921 20.607 14.086 21.139 13.951 C 21.67 13.815 22.085 13.4 22.221 12.869 C 22.356 12.337 22.191 11.774 21.79 11.4 Z" />
              <path d="M 23.56 6.8 L 22.15 5.39 C 22.042 5.291 21.986 5.146 22 5 C 21.998 4.864 22.052 4.734 22.15 4.64 C 22.656 4.134 22.853 3.398 22.668 2.707 C 22.483 2.017 21.943 1.477 21.253 1.292 C 20.562 1.107 19.826 1.304 19.32 1.81 C 19.244 1.915 19.128 1.983 19 2 C 18.864 2.002 18.734 1.948 18.64 1.85 L 17.2 0.44 C 16.609 -0.111 15.688 -0.094 15.117 0.477 C 14.546 1.048 14.529 1.969 15.08 2.56 L 21.44 8.93 C 22.028 9.515 22.98 9.513 23.565 8.925 C 24.15 8.337 24.148 7.385 23.56 6.8 Z" />
              <path d="M 2.56 15.08 C 1.969 14.529 1.048 14.546 0.477 15.117 C -0.094 15.688 -0.111 16.609 0.44 17.2 L 1.85 18.61 C 1.958 18.709 2.014 18.854 2 19 C 2.002 19.136 1.948 19.266 1.85 19.36 C 1.069 20.141 1.069 21.409 1.85 22.19 C 2.631 22.971 3.899 22.971 4.68 22.19 C 4.774 22.095 4.902 22.042 5.035 22.042 C 5.168 22.042 5.296 22.095 5.39 22.19 L 6.8 23.56 C 7.391 24.111 8.312 24.094 8.883 23.523 C 9.454 22.952 9.471 22.031 8.92 21.44 Z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "pitch":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(4, 4)" fill="${color}">
            <g transform="matrix(0.83 0 0 0.83 12 12)">
              <g>
                <g transform="matrix(1 0 0 1 -1.74 0.01)">
                  <path transform=" translate(-10.26, -12.01)" d="M 11.14 9.51 C 11.063753367353604 9.475343434198509 10.976246632646397 9.475343434198509 10.9 9.51 C 9.907674279768369 9.94534042991874 9.26676797910953 10.926380313507059 9.26676797910953 12.01 C 9.26676797910953 13.093619686492941 9.907674279768369 14.07465957008126 10.9 14.51 C 10.976246632646397 14.54465656580149 11.063753367353604 14.54465656580149 11.14 14.51 C 11.208302716065779 14.46176149101716 11.249236081834479 14.38361597454964 11.25 14.299999999999999 L 11.25 9.72 C 11.249236081834479 9.63638402545036 11.208302716065779 9.55823850898284 11.14 9.51 Z" stroke-linecap="round"/>
                </g>
                <g transform="matrix(1 0 0 1 1.74 -0.01)">
                  <path transform=" translate(-13.74, -11.99)" d="M 12.86 14.49 C 12.936246632646396 14.524656565801491 13.023753367353603 14.524656565801491 13.1 14.49 C 14.092325720231631 14.05465957008126 14.73323202089047 13.073619686492941 14.73323202089047 11.99 C 14.73323202089047 10.906380313507059 14.092325720231631 9.92534042991874 13.1 9.49 C 13.023753367353603 9.45534343419851 12.936246632646396 9.45534343419851 12.86 9.49 C 12.791697283934221 9.53823850898284 12.750763918165521 9.61638402545036 12.75 9.700000000000001 L 12.75 14.260000000000002 C 12.743981749041046 14.350616262711943 12.785681114886929 14.437805845844244 12.86 14.49 Z" stroke-linecap="round"/>
                </g>
                <g transform="matrix(1 0 0 1 10.63 0)">
                  <rect x="-1.375" y="-3.75" rx="0.5" ry="0.5" width="2.75" height="7.5"/>
                </g>
                <g transform="matrix(1 0 0 1 -6.38 0)">
                  <path transform=" translate(-5.63, -12)" d="M 10.75 4 L 1 4 C 0.44771525016920655 4 0 4.447715250169207 0 5 L 0 6.25 C 0 6.526142374915397 0.22385762508460327 6.75 0.5 6.75 L 2.5 6.75 C 3.464226327100342 6.7554631699623515 4.244536830037648 7.535773672899657 4.25 8.5 L 4.25 15.5 C 4.2445368300376485 16.46422632710034 3.4642263271003424 17.24453683003765 2.5 17.25 L 0.5 17.25 C 0.22385762508460327 17.25 0 17.4738576250846 0 17.75 L 0 19 C 0 19.552284749830793 0.44771525016920655 20 1 20 L 10.75 20 C 11.026142374915397 20 11.25 19.7761423749154 11.25 19.5 L 11.25 16.57 C 11.248736904731748 16.344967503972374 11.097297694477081 16.148505825804154 10.88 16.09 C 9.036424534120538 15.586144803315285 7.757810359586995 13.911188258026632 7.757810359586995 12 C 7.757810359586995 10.088811741973368 9.036424534120538 8.413855196684715 10.88 7.91 C 11.097297694477081 7.851494174195845 11.248736904731748 7.655032496027626 11.25 7.43 L 11.25 4.5 C 11.25 4.223857625084603 11.026142374915397 4 10.75 4 Z" stroke-linecap="round"/>
                </g>
                <g transform="matrix(1 0 0 1 -10.63 0)">
                  <rect x="-1.375" y="-3.75" rx="0.5" ry="0.5" width="2.75" height="7.5"/>
                </g>
                <g transform="matrix(1 0 0 1 6.38 0)">
                  <path transform=" translate(-18.38, -12)" d="M 23 4 L 13.25 4 C 12.973857625084603 4 12.75 4.223857625084603 12.75 4.5 L 12.75 7.43 C 12.751263095268252 7.655032496027626 12.902702305522919 7.851494174195845 13.12 7.91 C 14.963575465879464 8.413855196684715 16.242189640413006 10.088811741973366 16.242189640413006 12 C 16.242189640413006 13.911188258026632 14.963575465879464 15.586144803315285 13.12 16.09 C 12.902702305522919 16.148505825804154 12.751263095268252 16.344967503972374 12.75 16.57 L 12.75 19.5 C 12.75 19.7761423749154 12.973857625084603 20 13.25 20 L 23 20 C 23.552284749830793 20 24 19.552284749830793 24 19 L 24 17.75 C 24 17.4738576250846 23.7761423749154 17.25 23.5 17.25 L 21.5 17.25 C 20.53577367289966 17.24453683003765 19.75546316996235 16.46422632710034 19.75 15.5 L 19.75 8.5 C 19.75546316996235 7.535773672899658 20.53577367289966 6.755463169962352 21.5 6.75 L 23.5 6.75 C 23.7761423749154 6.75 24 6.526142374915397 24 6.25 L 24 5 C 24 4.447715250169207 23.552284749830793 4 23 4 Z" stroke-linecap="round"/>
                </g>
              </g>
            </g>
          </g>
        </svg>`;
      break;
    case "hospital":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <rect x="8" y="14" width="16" height="4" rx="0.5" fill="${color}"/>
          <rect x="14" y="8" width="4" height="16" rx="0.5" fill="${color}"/>
        </svg>`;
      break;
    case "pharmacy":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <rect x="9" y="14.5" width="14" height="3" rx="0.5" fill="${color}"/>
          <rect x="14.5" y="9" width="3" height="14" rx="0.5" fill="${color}"/>
        </svg>`;
      break;
    case "bank":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(5, 5)">
            <svg width="22" height="22" viewBox="0 0 30 30" fill="${color}">
              <path d="M 12.990234 5 C 9.5055896 5 4.3635398 6.9775829 3.2324219 12.029297 C 3.1563633074623856 12.010459152560358 3.0783542090691642 12.000626032034168 3.0000000000000004 12 C 2.4477152501692068 12 2 12.447715250169207 2 13 C 2 13.552284749830793 2.4477152501692068 14 3 14 C 3.0026041567324833 14.000010172564847 3.0052083432675163 14.000010172564847 3.0078125 14 C 3.007229 14.045661 3 14.086754 3 14.132812 C 3 15.629871 3.383961 17.122004 4.1152344 18.478516 L 5.0351562 23.994141 C 5.1311563 24.575141 5.63175 25 6.21875 25 L 8.9902344 25 C 9.5782344 25 10.079781 24.575141 10.175781 23.994141 L 10.279297 23.376953 C 11.538749 23.769799 12.94235 24 14.5 24 C 15.62133 24 16.692952 23.873157 17.707031 23.65625 L 18.287109 24.546875 C 18.471109 24.828875 18.787 25 19.125 25 L 22 25 C 22.631 25 23.104469 24.423687 22.980469 23.804688 L 22.537109 21.59375 C 23.599012 20.840965 24.455872 19.955658 25.050781 18.992188 L 26.09375 18.992188 C 26.64575 18.992188 27.126719 18.617031 27.261719 18.082031 L 27.964844 15.265625 C 28.116844 14.656625 27.775688 14.031984 27.179688 13.833984 L 25.6875 13.335938 C 25.348725 11.963242 24.74675 10.788067 23.958984 9.796875 C 24.526964 8.8402778 25 7.5833333 25 6 L 21.103516 7.2988281 C 18.41801 5.6425221 15.195999 5 12.990234 5 z M 14.007812 9 C 16.21377 9.0035684 18 10.79325 18 13 C 18 14.088 17.561516 15.066203 16.853516 15.783203 C 16.515913 16.12508 16.284806 16.547888 16.146484 17 L 11.853516 17 C 11.719455 16.553105 11.498153 16.136824 11.164062 15.802734 C 10.233063 14.870734 9.7580469 13.487094 10.123047 11.996094 C 10.469047 10.582094 11.622063 9.4413281 13.039062 9.1113281 C 13.367313 9.0349531 13.692676 8.9994902 14.007812 9 z M 12 18 L 15.990234 18 C 15.942953 18.953817 15.283161 19.818479 14.335938 19.972656 C 13.082937 20.175656 12 19.215 12 18 z" />
            </svg>
          </g>
       </svg>`;
      break;
    case "supermarket":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <path d="M8 10 L10 10 L12 20 L22 20" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="13" cy="23" r="1.5" fill="${color}"/>
          <circle cx="21" cy="23" r="1.5" fill="${color}"/>
          <rect x="11" y="12" width="11" height="8" rx="1" fill="none" stroke="${color}" stroke-width="2"/>
        </svg>`;
      break;
    case "hairdresser":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(8, 8)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="${color}">
              <path fill-rule="evenodd" d="M8.128 9.155a3.751 3.751 0 1 1 .713-1.321l1.136.656a.75.75 0 0 1 .222 1.104l-.006.007a.75.75 0 0 1-1.032.157 1.421 1.421 0 0 0-.113-.072l-.92-.531Zm-4.827-3.53a2.25 2.25 0 0 1 3.994 2.063.756.756 0 0 0-.122.23 2.25 2.25 0 0 1-3.872-2.293ZM13.348 8.272a5.073 5.073 0 0 0-3.428 3.57 5.08 5.08 0 0 0-.165 1.202 1.415 1.415 0 0 1-.707 1.201l-.96.554a3.751 3.751 0 1 0 .734 1.309l13.729-7.926a.75.75 0 0 0-.181-1.374l-.803-.215a5.25 5.25 0 0 0-2.894.05l-5.325 1.629Zm-9.223 7.03a2.25 2.25 0 1 0 2.25 3.897 2.25 2.25 0 0 0-2.25-3.897ZM12 12.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clip-rule="evenodd" />
              <path d="M16.372 12.615a.75.75 0 0 1 .75 0l5.43 3.135a.75.75 0 0 1-.182 1.374l-.802.215a5.25 5.25 0 0 1-2.894-.051l-5.147-1.574a.75.75 0 0 1-.156-1.367l3-1.732Z" />
            </svg>
          </g>
        </svg>`;
      break;
    case "hotel":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <rect x="8" y="13" width="16" height="10" rx="1" fill="none" stroke="${color}" stroke-width="2.5"/>
          <rect x="8" y="13" width="16" height="10" rx="1" fill="${color}" opacity="0.2"/>
          <ellipse cx="11" cy="17" rx="2" ry="2.5" fill="${color}"/>
          <line x1="8" y1="23" x2="8" y2="25" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
          <line x1="24" y1="23" x2="24" y2="25" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
      break; 
    case "hostel":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <rect x="8" y="13" width="16" height="10" rx="1" fill="none" stroke="${color}" stroke-width="2.5"/>
          <rect x="8" y="13" width="16" height="10" rx="1" fill="${color}" opacity="0.2"/>
          <ellipse cx="11" cy="17" rx="2" ry="2.5" fill="${color}"/>
          <line x1="8" y1="23" x2="8" y2="25" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
          <line x1="24" y1="23" x2="24" y2="25" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
      break;    
    case "station":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <g transform="translate(6, 6)">
            <svg width="20" height="20" viewBox="0 0 30 30" fill="${color}">
              <path d="M 15 3 C 10.724 3 7.3515625 4.1074219 7.3515625 4.1074219 L 7.3378906 4.1210938 C 6.8009854 4.3103652 6.3661686 4.7145011 6.1503906 5.2382812 C 6.1503906 5.2382812 4 10.499 4 12 C 4 12.691074 4.6049974 19.025389 5.0058594 22.142578 C 5.0121487952333315 22.284179916815827 5.028465703096799 22.425158072937005 5.0546875 22.564453 C 5.0556668 22.571722 5.0576176 22.584576 5.0585938 22.591797 L 5.0625 22.595703 C 5.345693846844594 23.993489861428316 6.5738144787430235 24.998687053227975 8 25 L 8.28125 25 L 6.6816406 29 L 9 29 L 10.599609 25 L 15 25 L 19.400391 25 L 21 29 L 23.318359 29 L 21.71875 25 L 22 25 C 23.42751980295069 24.99942728021547 24.656923131148574 23.99303195480079 24.939453 22.59375 L 24.941406 22.591797 C 24.942871 22.580966 24.945794 22.56172 24.947266 22.550781 C 24.96944588097563 22.42680683528658 24.983796945087217 22.301558998714135 24.990234 22.175781 C 25.391037 19.069474 26 12.693212 26 12 C 26 10.499 23.849609 5.2382812 23.849609 5.2382812 C 23.633525 4.7137574 23.198123 4.3080475 22.660156 4.1191406 L 22.648438 4.109375 C 22.649438 4.108375 19.276 3 15 3 z M 15 5 C 18.655 5 21.651906 5.8997656 22.003906 6.0097656 C 22.428906 7.0507656 22.869516 8.2217656 23.228516 9.2597656 C 23.490516 10.016766 22.837781 10.769141 22.050781 10.619141 C 20.571781 10.336141 17.322 10 15 10 C 12.675 10 9.4223594 10.338094 7.9433594 10.621094 C 7.1583594 10.771094 6.506625 10.020672 6.765625 9.2636719 C 7.121625 8.2226719 7.5558438 7.0525313 7.9648438 6.0195312 C 7.9958438 6.0095312 11.092 5 15 5 z M 15 13 C 16.105 13 17 13.895 17 15 C 17 16.105 16.105 17 15 17 C 13.895 17 13 16.105 13 15 C 13 13.895 13.895 13 15 13 z" />
            </svg>
          </g>
        </svg>`;
      break;    
    case "parking":
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <rect x="8" y="8" width="16" height="16" rx="2" fill="none" stroke="${color}" stroke-width="2.5"/>
          <path d="M12 12 V20 M12 12 H16 Q18 12 18 15 Q18 18 16 18 H12" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      break;
    default:
      svg = `
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
          <circle cx="16" cy="16" r="6" fill="${color}"/>
        </svg>`;
  }

  div.innerHTML = svg;
  div.style.width = "32px";
  div.style.height = "32px";

  return div;
}

// --- Helper: clean tags for display ---
function cleanTags(tags) {
  const skipPrefixes = ['addr:', 'contact:', 'source:', 'attribution:', '@', 'wikidata', 'wikipedia'];
  const skipKeys = ['name', 'name:en', 'name:es', 'created_by', 'fixme'];

  return Object.entries(tags)
    .filter(([k, v]) => {
      return !skipKeys.includes(k) && !skipPrefixes.some(prefix => k.startsWith(prefix));
    })
    .slice(0, 3);
}

// --- Render GeoJSON with SVG markers ---
async function renderData(geojson, styleDefinitions, queryInfo) {
  if (!geojson || !geojson.features || !geojson.features.length) {
    addMessage("Agent", "No results found.");
    return;
  }

  const features = geojson.features;

  // Compute a simple bbox to zoom to
  const bounds = new maplibregl.LngLatBounds();
  features.forEach(f => {
    if (f.geometry && f.geometry.type === "Point") {
      const [lng, lat] = f.geometry.coordinates;
      bounds.extend([lng, lat]);
    }
  });
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
  }

  // Detect category from features (try multiple features to find a valid one)
  let detectedCategory = "poi";
  for (let i = 0; i < Math.min(features.length, 10); i++) {
    const tags = features[i]?.properties?.tags || features[i]?.properties || {};
    const cat = getCategoryFromTags(tags);
    if (cat !== "poi") {
      detectedCategory = cat;
      break;
    }
  }

  // Use detected category for consistency
  const category = detectedCategory;
  const color = CATEGORIES[category]?.color || CATEGORIES.poi.color;

  console.log("Detected category:", category, "Color:", color, "Features:", features.length);

  // Create layer ID from category and place
  const layerId = `${category}_${queryInfo.place_name || 'unknown'}_${Date.now()}`;
  const layerName = `${category} (${queryInfo.place_name || 'unknown'})`;

  // Create new layer
  layers[layerId] = {
    markers: [],
    name: layerName,
    category: category,
    color: color
  };

  // Helper: calculate centroid of a polygon
  function getCentroid(geometry) {
    if (geometry.type === "Point") {
      return geometry.coordinates;
    }

    if (geometry.type === "Polygon") {
      const coords = geometry.coordinates[0]; // outer ring
      let sumLat = 0, sumLng = 0;
      coords.forEach(([lng, lat]) => {
        sumLng += lng;
        sumLat += lat;
      });
      return [sumLng / coords.length, sumLat / coords.length];
    }

    if (geometry.type === "MultiPolygon") {
      const coords = geometry.coordinates[0][0]; // first polygon, outer ring
      let sumLat = 0, sumLng = 0;
      coords.forEach(([lng, lat]) => {
        sumLng += lng;
        sumLat += lat;
      });
      return [sumLng / coords.length, sumLat / coords.length];
    }

    return null;
  }

  // Create markers
  let pointCount = 0;
  let skippedCount = 0;

  features.forEach(f => {
    if (!f.geometry) {
      console.warn("Feature without geometry:", f);
      skippedCount++;
      return;
    }

    // Get centroid for any geometry type
    const coords = getCentroid(f.geometry);
    if (!coords) {
      console.warn("Could not calculate centroid for:", f.geometry.type, f.id);
      skippedCount++;
      return;
    }

    pointCount++;
    const [lng, lat] = coords;

    // Try multiple sources for tags
    const tags = f.properties?.tags || f.properties || {};

    const el = createSVGIconWithColor(category, color);

    // Get name for tooltip and popup
    const name = tags.name || tags["name:en"] || tags["name:es"] || f.properties?.name || "Unnamed";

    // Create tooltip (shown on hover)
    el.setAttribute('title', name);

    // Create improved popup with icon and clean tags
    const iconSvg = createSVGIconWithColor(category, color).innerHTML;
    const tagEntries = cleanTags(tags);

    const popupContent = `
      <div style="display: flex; align-items: flex-start; gap: 10px;">
        <div style="flex-shrink: 0; margin-top: 2px;">${iconSvg}</div>
        <div style="flex: 1; min-width: 0;">
          <strong style="display: block; margin-bottom: ${tagEntries.length > 0 ? '8px' : '0'};">${name}</strong>
          ${tagEntries.length > 0 ? tagEntries.map(([k, v]) => `<div style="font-size: 12px; margin-bottom: 4px; word-wrap: break-word;"><span style="color: #666;">${k}:</span> ${v}</div>`).join('') : ''}
        </div>
      </div>
    `;

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup({ offset: 20, maxWidth: '280px' }).setHTML(popupContent))
      .addTo(map);

    layers[layerId].markers.push(marker);
  });

  console.log(`Rendered ${pointCount} points, skipped ${skippedCount} non-point features`);

  updateLegend();
}

// --- Initialize legend with all categories ---
function initLegend() {
  const legend = document.getElementById("legend");
  if (!legend) return;

  legend.innerHTML = '';

  // Create legend items for all categories
  Object.entries(CATEGORIES).forEach(([categoryKey, categoryData]) => {
    if (categoryKey === 'poi') return; // Skip generic POI

    const item = document.createElement("div");
    item.className = "legend-item";
    item.dataset.category = categoryKey;

    const iconSvg = createSVGIconWithColor(categoryKey, categoryData.color).innerHTML;

    item.innerHTML = `
      ${iconSvg}
      <span class="legend-label">${categoryData.label}</span>
      <span class="legend-count">0</span>
      <button class="legend-remove-category" data-category="${categoryKey}" style="display:none;">×</button>
    `;

    legend.appendChild(item);
  });

  // Add clear all button
  const clearBtn = document.createElement("button");
  clearBtn.className = "legend-clear-all";
  clearBtn.textContent = "Clear All";
  clearBtn.onclick = clearAllLayers;
  legend.appendChild(clearBtn);
}

// --- Update legend counts and active states ---
function updateLegend() {
  // Count features per category
  const categoryCounts = {};
  Object.values(layers).forEach(layer => {
    categoryCounts[layer.category] = (categoryCounts[layer.category] || 0) + layer.markers.length;
  });

  // Update each legend item
  document.querySelectorAll('.legend-item').forEach(item => {
    const category = item.dataset.category;
    const count = categoryCounts[category] || 0;
    const countSpan = item.querySelector('.legend-count');
    const removeBtn = item.querySelector('.legend-remove-category');

    if (countSpan) {
      countSpan.textContent = count;
    }

    if (count > 0) {
      item.classList.add('active');
      if (removeBtn) removeBtn.style.display = 'flex';
    } else {
      item.classList.remove('active');
      if (removeBtn) removeBtn.style.display = 'none';
    }
  });

  // Attach remove handlers to category buttons
  document.querySelectorAll('.legend-remove-category').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      removeCategoryLayers(btn.dataset.category);
    };
  });
}

// --- Initialize on page load ---
document.addEventListener("DOMContentLoaded", () => {
  // Init legend
  initLegend();

  // Info button toggle
  const infoButton = document.getElementById("info-button");
  const closeButton = document.getElementById("close-info");
  const panel = document.getElementById("info-panel");

  // Logic for the 'i' button
  infoButton.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
  
  // Logic for the 'X' button
  if (closeButton) {
    closeButton.addEventListener("click", () => {
      panel.style.display = "none";
    });
  }
});

// --- Send button logic ---
document.getElementById("send").onclick = async () => {
  const prompt = document.getElementById("command").value.trim();
  if (!prompt) return;

  addMessage("You", prompt);

  try {
    const ai = await getAIQuery(prompt);
    console.log("=== AI Response ===", ai);
    addMessage("Agent", `Looking for ${ai.place_name || "location"}...`);

    // Get bbox from place name using Nominatim
    const placeName = ai.place_name || "Madrid";
    const { bbox, center } = await getBboxFromPlace(placeName);
    console.log("=== Place Info ===", { placeName, bbox, center });

    // Replace ALL occurrences of {{bbox}} in the query
    const query = ai.query.replaceAll("{{bbox}}", bbox);
    console.log("=== Final Overpass Query ===", query);

    addMessage("Agent", "Running query...");
    const geojson = await fetchOverpass(query);
    console.log("GeoJSON:", geojson);

    // Center map on the place
    if (center) {
      map.setCenter(center);
      map.setZoom(12);
    }

    await renderData(geojson, ai.style_definitions, { place_name: placeName });
    addMessage("Agent", `Found ${geojson.features.length} results ✅`);
  } catch (err) {
    console.error(err);
    addMessage("Agent", `Error: ${err.message} ❌`);
  }
};
