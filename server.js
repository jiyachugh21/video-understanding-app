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
}).then(() => console.log('MongoDB Connected')).catch(err => console.log('MongoDB Error:', err));

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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const upload = multer({ dest: '/tmp/uploads/' });

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
    const videoData = fs.readFileSync(video.filePath);
    const base64Video = videoData.toString('base64');
    
    const ext = path.extname(video.originalFilename).toLowerCase();
    let mimeType = 'video/mp4';
    if (ext === '.mov') mimeType = 'video/quicktime';
    if (ext === '.avi') mimeType = 'video/x-msvideo';
    if (ext === '.webm') mimeType = 'video/webm';
    
    let transcript = '';
    let summary = '';
    let quizQuestions = [];
    let answerKey = '';

    try {
      const response = await model.generateContent([
        {
          inlineData: {
            data: base64Video,
            mimeType: mimeType,
          },
        },
        `Analyze this video and provide:
1. Full transcript of all dialogue and speech
2. Detailed description of all scenes
3. Key moments and topics
4. Complete breakdown of what happens

Be very detailed.`
      ]);

      transcript = response.response.text();

      const summaryResult = await model.generateContent([
        `Provide a 2-3 sentence summary of this video:\n\n${transcript}`
      ]);
      summary = summaryResult.response.text();

      const quizResult = await model.generateContent([
        `Create 3 multiple choice questions based on this video content.
        
Respond ONLY with valid JSON:
{"questions": [{"question": "Question?", "options": ["A", "B", "C", "D"], "correctAnswer": "A"}]}

Content:
${transcript}`
      ]);

      const quizText = quizResult.response.text();
      const jsonMatch = quizText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        quizQuestions = parsed.questions || [];
        answerKey = parsed.questions?.map((q, i) => `Q${i+1}: ${q.correctAnswer}`).join('\n') || '';
      } else {
        throw new Error('Invalid quiz format');
      }
    } catch (err) {
      transcript = 'Video analysis failed';
      summary = 'Unable to process video';
      quizQuestions = [];
      answerKey = '';
    }

    video.transcript = transcript;
    video.summary = summary;
    video.quizQuestions = quizQuestions;
    video.answerKey = answerKey;
    video.status = 'completed';
    await video.save();
  } catch (error) {
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
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;