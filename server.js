/**
 * Video Understanding App - Backend Server
 * Uses Gemini API for summarization and quiz generation
 * Gemini API Key: AIzaSyBStZwH21K492DLIVWNhpbmv5j52sk6Lf8
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const speech = require('@google-cloud/speech');
const vision = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Your Gemini API Key - Hardcoded
const GEMINI_API_KEY = 'AIzaSyBStZwH21K492DLIVWNhpbmv5j52sk6Lf8';

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/video-understanding', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Database Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const videoProcessSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  originalFilename: String,
  uploadedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['processing', 'completed', 'failed'], default: 'processing' },
  transcript: String,
  extractedText: String,
  visualDescription: String,
  summary: String,
  quizQuestions: [{
    question: String,
    options: [String],
    correctAnswer: String,
  }],
  answerKey: String,
  error: String,
});

const User = mongoose.model('User', userSchema);
const VideoProcess = mongoose.model('VideoProcess', videoProcessSchema);

// Multer Configuration
const upload = multer({
  dest: '/tmp/uploads',
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a video.'));
    }
  },
});

// Initialize AI Clients
const speechClient = new speech.SpeechClient();
const visionClient = new vision.ImageAnnotatorClient();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

console.log('🔑 Gemini API Key Loaded: AIzaSyBStZwH21K492DLIVWNhpbmv5j52sk6Lf8');

// Middleware: Verify JWT Token
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.userId = decoded.userId;
    next();
  });
}

// ========== ROUTES ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key', {
      expiresIn: '7d',
    });

    res.json({ token, userId: user._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key', {
      expiresIn: '7d',
    });

    res.json({ token, userId: user._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Extract audio from video using FFmpeg
async function extractAudioFromVideo(videoPath) {
  const { execSync } = require('child_process');
  const audioPath = '/tmp/audio.wav';
  try {
    execSync(`ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y 2>/dev/null`);
    return audioPath;
  } catch (error) {
    console.error('❌ FFmpeg error:', error.message);
    return null;
  }
}

// Transcribe audio using Google Speech-to-Text
async function transcribeAudio(audioPath) {
  try {
    const file = fs.readFileSync(audioPath);
    const audioBytes = file.toString('base64');

    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-US',
      },
    };

    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      .map((result) => result.alternatives[0].transcript)
      .join('\n');
    return transcription;
  } catch (error) {
    console.error('❌ Transcription error:', error.message);
    return '';
  }
}

// Extract frames and analyze using Vision API + Gemini
async function analyzeVideoFrames(videoPath) {
  const { execSync } = require('child_process');
  const frameDir = '/tmp/frames';
  
  try {
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir);
    
    // Extract 5 key frames
    execSync(`ffmpeg -i "${videoPath}" -vf "fps=1/5" "${frameDir}/frame_%03d.jpg" -y 2>/dev/null`);
    
    const files = fs.readdirSync(frameDir).filter((f) => f.endsWith('.jpg'));
    let allText = '';
    let descriptions = [];

    for (const file of files.slice(0, 5)) {
      const imagePath = path.join(frameDir, file);
      const imageData = fs.readFileSync(imagePath);
      const base64Image = imageData.toString('base64');

      // Use Vision API for OCR
      try {
        const request = {
          image: { content: base64Image },
        };

        const [result] = await visionClient.textDetection(request);
        const detectedText = result.fullTextAnnotation?.text || '';
        allText += detectedText + '\n';
      } catch (e) {
        console.error('❌ Vision API error:', e.message);
      }

      // Use Gemini for image description
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const imgPart = {
          inlineData: {
            data: base64Image,
            mimeType: 'image/jpeg',
          },
        };
        const response = await model.generateContent([
          'Describe what you see in this image in detail. Focus on key information, text, and context.',
          imgPart,
        ]);
        descriptions.push(response.response.text());
      } catch (e) {
        console.error('❌ Gemini vision error:', e.message);
      }
    }

    return {
      extractedText: allText,
      visualDescription: descriptions.join('\n\n'),
    };
  } catch (error) {
    console.error('❌ Frame analysis error:', error.message);
    return { extractedText: '', visualDescription: '' };
  }
}

// Generate summary and quiz using Gemini
async function generateSummaryAndQuiz(content) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Generate Summary
    const summaryPrompt = `Based on this content from a video, generate a concise summary (2-3 sentences):

Content:
${content}

Summary:`;

    console.log('📝 Generating summary with Gemini...');
    const summaryResponse = await model.generateContent(summaryPrompt);
    const summary = summaryResponse.response.text();
    console.log('✅ Summary generated:', summary.substring(0, 100));

    // Generate Quiz Questions
    const quizPrompt = `Based on this content, generate 3 quiz questions with 4 multiple choice options each. Return ONLY valid JSON (no markdown, no code blocks):

Content:
${content}

Return a JSON array with this structure:
[
  {
    "question": "Question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": "Option A"
  }
]`;

    console.log('❓ Generating quiz with Gemini...');
    const quizResponse = await model.generateContent(quizPrompt);
    const quizText = quizResponse.response.text();
    
    // Parse JSON from response - handle markdown code blocks
    let jsonText = quizText;
    
    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    
    // Extract JSON array
    const jsonMatch = jsonText.match(/\[\s*\{[\s\S]*\}\s*\]/);
    
    let quizQuestions = [];
    if (jsonMatch) {
      try {
        quizQuestions = JSON.parse(jsonMatch[0]);
        console.log('✅ Quiz questions parsed:', quizQuestions.length);
      } catch (e) {
        console.error('❌ JSON parse error:', e.message);
        console.log('Failed to parse:', jsonMatch[0].substring(0, 200));
        quizQuestions = [];
      }
    } else {
      console.warn('⚠️ No JSON array found in response');
    }

    // Generate Answer Key
    const answerKey = quizQuestions
      .map((q, i) => `Q${i + 1}: ${q.question}\nA: ${q.correctAnswer}`)
      .join('\n\n');

    return { summary, quizQuestions, answerKey };
  } catch (error) {
    console.error('❌ Summary/Quiz generation error:', error.message);
    return { summary: '', quizQuestions: [], answerKey: '' };
  }
}

// Upload and process video
app.post('/api/videos/upload', verifyToken, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Create initial database entry
    const videoProcess = new VideoProcess({
      userId: req.userId,
      originalFilename: req.file.originalname,
      status: 'processing',
    });
    await videoProcess.save();

    res.json({ videoId: videoProcess._id, status: 'processing' });

    // Process video asynchronously
    setImmediate(async () => {
      try {
        const videoPath = req.file.path;
        console.log('🎬 Processing video:', videoPath);

        // Extract audio and transcribe
        console.log('🔊 Extracting audio...');
        const audioPath = await extractAudioFromVideo(videoPath);
        let transcript = '';
        if (audioPath) {
          console.log('🎙️ Transcribing audio...');
          transcript = await transcribeAudio(audioPath);
          console.log('✅ Transcript length:', transcript.length);
        }

        // Analyze frames for text and visual content
        console.log('🖼️ Analyzing video frames...');
        const { extractedText, visualDescription } = await analyzeVideoFrames(videoPath);
        console.log('✅ Extracted text length:', extractedText.length);
        console.log('✅ Visual description length:', visualDescription.length);

        // Combine all content
        const combinedContent = `Transcript: ${transcript}\n\nExtracted Text: ${extractedText}\n\nVisual Description: ${visualDescription}`;
        console.log('📊 Combined content length:', combinedContent.length);

        // Generate summary and quiz
        console.log('🤖 Generating summary and quiz with Gemini...');
        const { summary, quizQuestions, answerKey } = await generateSummaryAndQuiz(combinedContent);

        // Update database
        videoProcess.status = 'completed';
        videoProcess.transcript = transcript;
        videoProcess.extractedText = extractedText;
        videoProcess.visualDescription = visualDescription;
        videoProcess.summary = summary;
        videoProcess.quizQuestions = quizQuestions;
        videoProcess.answerKey = answerKey;
        await videoProcess.save();

        console.log('✅ Video processing completed successfully!');

        // Cleanup
        try {
          fs.unlinkSync(videoPath);
          if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        } catch (e) {
          console.warn('⚠️ Cleanup error:', e.message);
        }
      } catch (error) {
        console.error('❌ Processing error:', error);
        videoProcess.status = 'failed';
        videoProcess.error = error.message;
        await videoProcess.save();
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's videos
app.get('/api/videos', verifyToken, async (req, res) => {
  try {
    const videos = await VideoProcess.find({ userId: req.userId }).sort({ uploadedAt: -1 });
    res.json(videos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get video details
app.get('/api/videos/:videoId', verifyToken, async (req, res) => {
  try {
    const video = await VideoProcess.findById(req.params.videoId);
    if (!video || video.userId.toString() !== req.userId) {
      return res.status(404).json({ error: 'Video not found' });
    }
    res.json(video);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    geminiConfigured: true,
    geminiKey: GEMINI_API_KEY.substring(0, 20) + '...',
  });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Gemini API configured: YES`);
  console.log(`✅ API Key: ${GEMINI_API_KEY.substring(0, 20)}...`);
  console.log(`✅ MongoDB: ${process.env.MONGODB_URI || 'mongodb://localhost:27017'}`);
  console.log('═══════════════════════════════════════════════════════════\n');
});
