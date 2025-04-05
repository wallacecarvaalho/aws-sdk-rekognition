import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import { readFile, unlink } from 'fs/promises';
import { 
  RekognitionClient, 
  CompareFacesCommand 
} from "@aws-sdk/client-rekognition";
import { 
  S3Client, 
  PutObjectCommand 
} from "@aws-sdk/client-s3";
import axios from 'axios';

dotenv.config();


const app = express();
app.use(cors());

async function authenticate() {
  const response = await axios.post(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, null, {
    params: {
      grant_type: 'password',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      username: process.env.SF_USERNAME,
      password: process.env.SF_PASSWORD
    }
  });

  return response.data;
}

async function atualizarSalesforce(accountId, updatedFields){
  try {
    const auth = await authenticate();
    const instanceUrl = auth.instance_url;
    const accessToken = auth.access_token;

    const response = await axios.patch(
      `${instanceUrl}/services/data/v60.0/sobjects/Account/${accountId}`,
      updatedFields,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return(`Account ${accountId} atualizado com sucesso.`);
  } catch (error) {
    return('Erro ao atualizar Account:', error.response?.data || error.message);
  }
}

// Configure multer for image upload
const upload = multer({ 
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
}).single('target');

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Configure AWS Clients
const rekognitionClient = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

app.post('/compare', upload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    }

    const targetContent = await readFile(req.file.path);
    const targetKey = `target-${Date.now()}.jpg`;

    // Upload to S3
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: targetKey,
      Body: targetContent,
      ContentType: req.file.mimetype
    }));

    // Compare faces
    const command = new CompareFacesCommand({
      SourceImage: {
        S3Object: {
          Bucket: process.env.AWS_BUCKET,
          Name: 'wallace.jpg'
        }
      },
      TargetImage: {
        S3Object: {
          Bucket: process.env.AWS_BUCKET,
          Name: targetKey
        }
      },
      SimilarityThreshold: 80
    });

    const data = await rekognitionClient.send(command);
    await unlink(req.file.path); // remove temporary file

    const match = data.FaceMatches && data.FaceMatches[0];

    if (match) {
      const salesforceMessage = atualizarSalesforce('001Hr000027BzOhIAK', {
                                  isVerified__c: true
                                });
      res.json({
        match: true,
        similarity: match.Similarity.toFixed(2),
        salesforce: salesforceMessage
      });
    } else {
      res.json({
        match: false,
        message: 'Nenhuma correspondência encontrada'
      });
    }

  } catch (error) {
    console.error('Erro:', error);

    if (req.file?.path) {
      try {
        await unlink(req.file.path);
      } catch (e) {
        console.error('Erro ao remover arquivo temporário:', e);
      }
    }

    res.status(500).json({
      error: 'Erro geral',
      details: error.message
    });
  }
});

app.listen(3002, () => console.log('🚀 Servidor rodando na porta 3002'));