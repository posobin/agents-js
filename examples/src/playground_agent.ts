// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import type { LocalParticipant, Participant, TrackPublication } from '@livekit/rtc-node';
import { RemoteParticipant, TrackSource } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // console.log(`connecting to room ${ctx.room.name}`);
    console.log('Connecting to room...');
    await ctx.connect();
    console.log('Connected to room successfully');

    console.log('Waiting for participant...');
    const participant = await ctx.waitForParticipant();
    console.log(`Participant ${participant.identity} joined`);

    console.log('Starting multimodal agent...');
    await runMultimodalAgent(ctx, participant);
    console.log('Multimodal agent started successfully');

    console.log('Agent initialization complete');
  },
});

type TurnDetectionType =
  | {
      type: 'server_vad';
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    }
  | {
      type: 'none';
    };

interface SessionConfig {
  openaiApiKey: string;
  instructions: string;
  voice: string;
  temperature: number;
  maxOutputTokens?: number;
  modalities: string[];
  turnDetection: TurnDetectionType;
}

function parseSessionConfig(data: any): SessionConfig {
  const turnDetection: TurnDetectionType =
    data.turn_detection_type === 'none'
      ? { type: 'none' }
      : {
          type: 'server_vad',
          ...(data.vad_threshold !== undefined && {
            threshold: parseFloat(data.vad_threshold),
          }),
          ...(data.vad_prefix_padding_ms !== undefined && {
            prefix_padding_ms: parseInt(data.vad_prefix_padding_ms),
          }),
          ...(data.vad_silence_duration_ms !== undefined && {
            silence_duration_ms: parseInt(data.vad_silence_duration_ms),
          }),
        };

  return {
    openaiApiKey: data.openai_api_key || '',
    instructions: data.instructions || '',
    voice: data.voice || '',
    temperature: parseFloat(data.temperature || '0.8'),
    maxOutputTokens: data.max_output_tokens || undefined,
    modalities: modalitiesFromString(data.modalities || 'text_and_audio'),
    turnDetection: turnDetection,
  };
}

function modalitiesFromString(modalities: string): ['text', 'audio'] | ['text'] {
  const modalitiesMap: { [key: string]: ['text', 'audio'] | ['text'] } = {
    text_and_audio: ['text', 'audio'],
    text_only: ['text'],
  };
  return modalitiesMap[modalities] || ['text', 'audio'];
}

function getMicrophoneTrackSid(participant: Participant): string | undefined {
  return Array.from(participant.trackPublications.values()).find(
    (track: TrackPublication) => track.source === TrackSource.SOURCE_MICROPHONE,
  )?.sid;
}

async function runMultimodalAgent(ctx: JobContext, participant: RemoteParticipant) {
  const metadata = JSON.parse(participant.metadata);
  const config = parseSessionConfig(metadata);
  console.log(`starting multimodal agent with config: ${JSON.stringify(config)}`);

  const model = new openai.realtime.RealtimeModel({
    apiKey: config.openaiApiKey,
    instructions: config.instructions,
    voice: config.voice,
    temperature: config.temperature,
    maxResponseOutputTokens: config.maxOutputTokens,
    modalities: config.modalities as ['text', 'audio'] | ['text'],
  });

  const agent = new multimodal.MultimodalAgent({ model });
  const session = (await agent.start(ctx.room)) as openai.realtime.RealtimeSession;

  session.defaultConversation.item.create({
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'Please begin the interaction with the user in a manner consistent with your instructions.',
      },
    ],
  });
  session.response.create();

  ctx.room.on(
    'participantAttributesChanged',
    (changedAttributes: Record<string, string>, changedParticipant: Participant) => {
      if (changedParticipant !== participant) {
        return;
      }
      const newConfig = parseSessionConfig({
        ...changedParticipant.attributes,
        ...changedAttributes,
      });

      session.sessionUpdate({
        instructions: newConfig.instructions,
        temperature: newConfig.temperature,
        maxResponseOutputTokens: newConfig.maxOutputTokens,
        modalities: newConfig.modalities as ['text', 'audio'] | ['text'],
        // voice: newConfig.voice,
        // inputAudioFormat: 'pcm16',
        // outputAudioFormat: 'pcm16',
        turnDetection: newConfig.turnDetection,
        // toolChoice: 'auto',
      });

      if ('instructions' in changedAttributes) {
        session.defaultConversation.item.create({
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Your instructions have changed. Please acknowledge this in a manner consistent with your new instructions. Do not explicitly mention the change in instructions.',
            },
          ],
        });
      }
      session.response.create();
    },
  );

  async function sendTranscription(
    ctx: JobContext,
    participant: Participant,
    trackSid: string,
    segmentId: string,
    text: string,
    isFinal: boolean = true,
  ) {
    const transcription = {
      participantIdentity: participant.identity,
      trackSid: trackSid,
      segments: [
        {
          id: segmentId,
          text: text,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
          final: isFinal,
        },
      ],
    };
    await (ctx.room.localParticipant as LocalParticipant).publishTranscription(transcription);
  }

  session.on('response_done', (response: openai.realtime.RealtimeResponse) => {
    let message: string | undefined;
    if (response.status === 'incomplete') {
      message = '🚫 response incomplete';
    } else if (response.status === 'failed') {
      message = '⚠️ response failed';
    } else {
      return;
    }

    const localParticipant = ctx.room.localParticipant as LocalParticipant;
    const trackSid = getMicrophoneTrackSid(localParticipant);

    if (trackSid) {
      sendTranscription(ctx, localParticipant, trackSid, uuidv4(), message);
    }
  });
}

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));