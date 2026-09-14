const API_KEY = 'AQ.Ab8RN6LYX8WuDpQt6UelU65n8xtnTJYoYBKvH2zoZqMZDkNvxQ'; 

async function checkModels() {
    console.log("מתחבר לגוגל כדי לבדוק איזה מודלים זמינים...");
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const data = await response.json();
        
        if (data.error) {
            console.log("שגיאה מגוגל:", data.error.message);
            return;
        }
        
        console.log("המודלים שפתוחים למפתח שלך (תומכים ביצירת טקסט):");
        data.models.forEach(m => {
            if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')) {
                console.log(m.name);
            }
        });
    } catch (e) {
        console.log("בעיה בתקשורת:", e.message);
    }
}

checkModels();