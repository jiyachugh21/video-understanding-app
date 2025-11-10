require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();


app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});


mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('✅ MongoDB Connected')).catch(err => console.log('MongoDB Error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true }
});

const videoSchema = new mongoose.Schema({
  userId: String,
  originalFilename: String,
  filePath: String,
  status: { type: String, default: 'processing' },
  transcript: String,
  summary: String,
  quizQuestions: Array,
  answerKey: String,
  error: String,
  uploadedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Video = mongoose.model('Video', videoSchema);


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'AIzaSyBStZwH21K492DLIVWNhpbmv5j52sk6Lf8');
const textModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const upload = multer({ dest: '/tmp/uploads/' });



app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword });
    await user.save();
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.json({ token, userId: user._id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) throw new Error('User not found');
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new Error('Invalid password');
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.json({ token, userId: user._id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};



app.post('/api/videos/upload', verifyToken, upload.single('video'), async (req, res) => {
  try {
    const video = new Video({
      userId: req.userId,
      originalFilename: req.file.originalname,
      filePath: req.file.path,
      status: 'processing'
    });
    await video.save();
    
    processVideo(video._id);
    res.json({ message: 'Video uploaded', videoId: video._id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/videos', verifyToken, async (req, res) => {
  try {
    const videos = await Video.find({ userId: req.userId });
    res.json(videos);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/videos/:id', verifyToken, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    res.json(video);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});



async function processVideo(videoId) {
  try {
    const video = await Video.findById(videoId);
    
    console.log('🎬 Processing video:', video.filePath);
    console.log('📊 File size:', fs.statSync(video.filePath).size, 'bytes');
    
    // Read the entire video file
    console.log('📖 Reading video file...');
    const videoData = fs.readFileSync(video.filePath);
    const base64Video = videoData.toString('base64');
    
    const ext = path.extname(video.originalFilename).toLowerCase();
    let mimeType = 'video/mp4';
    if (ext === '.mov') mimeType = 'video/quicktime';
    if (ext === '.avi') mimeType = 'video/x-msvideo';
    if (ext === '.webm') mimeType = 'video/webm';
    if (ext === '.flv') mimeType = 'video/x-flv';
    
    console.log(`🎥 Video MIME type: ${mimeType}`);
    
    let transcript = '';
    let summary = '';
    let quizQuestions = [];
    let answerKey = '';

    try {
      console.log('🚀 Sending entire video to Gemini for analysis...');
      
      const response = await visionModel.generateContent([
        {
          inlineData: {
            data: base64Video,
            mimeType: mimeType,
          },
        },
        `Please analyze this entire video thoroughly and provide:
1. Detailed description of all scenes and what happens
2. Any dialogue, speech, or narration (transcription)
3. Key moments and important scenes
4. Main topic or theme
5. Objects, people, or activities shown

Be as detailed as possible.`,
      ]);

      transcript = response.response.text();
      console.log('✅ Video analyzed by Gemini');
      console.log('📝 Analysis length:', transcript.length, 'characters');


      console.log('📋 Generating summary...');
      const summaryPrompt = `Based on this video analysis, provide a concise 2-3 sentence summary:\n\n${transcript}`;
      const summaryResult = await textModel.generateContent(summaryPrompt);
      summary = summaryResult.response.text();
      console.log('✅ Summary generated');

      console.log('❓ Generating quiz questions...');
      const quizPrompt = `Based on this video content, create 3 multiple choice quiz questions about what was shown. 

IMPORTANT: Respond ONLY with valid JSON in this exact format:
{"questions": [{"question": "Question text here?", "options": ["Option A", "Option B", "Option C", "Option D"], "correctAnswer": "Option A"}]}

Video content:
${transcript}`;
      
      const quizResult = await textModel.generateContent(quizPrompt);
      const quizText = quizResult.response.text();
      
      try {
        const jsonMatch = quizText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          quizQuestions = parsed.questions || [];
          answerKey = parsed.questions?.map((q, i) => `Q${i+1}: ${q.correctAnswer}`).join('\n') || '';
        }
      } catch (e) {
        console.log('⚠️  Quiz parsing issue, using defaults');
        quizQuestions = [{ 
          question: 'What was the main topic of the video?', 
          options: ['Topic A', 'Topic B', 'Topic C', 'Topic D'], 
          correctAnswer: 'Topic A' 
        }];
        answerKey = 'Q1: Topic A';
      }
      console.log('✅ Quiz generated with', quizQuestions.length, 'questions');

    } catch (err) {
      console.log('❌ Error during analysis:', err.message);
      transcript = 'Video could not be analyzed';
      summary = 'Unable to generate summary';
      quizQuestions = [{ 
        question: 'Sample question?', 
        options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'], 
        correctAnswer: 'Option 1' 
      }];
      answerKey = 'Q1: Option 1';
    }


    video.transcript = transcript;
    video.summary = summary;
    video.quizQuestions = quizQuestions;
    video.answerKey = answerKey;
    video.status = 'completed';
    await video.save();

    console.log('✅ Video processing completed successfully!');
    console.log('═══════════════════════════════════════════════════════════');
    
  } catch (error) {
    console.log('❌ Processing error:', error.message);
    try {
      const video = await Video.findById(videoId);
      video.status = 'failed';
      video.error = error.message;
      await video.save();
    } catch (e) {}
  }
}



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ Server running on port', PORT);
  console.log('✅ Gemini API configured: YES');
  console.log('✅ API Key:', (process.env.GEMINI_API_KEY || 'AIzaSyBStZwH21K492DLIVWNhpbmv5j52sk6Lf8').substring(0, 20) + '...');
  console.log('✅ MongoDB:', process.env.MONGODB_URI);
  console.log('═══════════════════════════════════════════════════════════');
});

module.exports = app;
