/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/no-floating-promises */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
  REST,
  Routes,
  TextChannel,
} from 'discord.js';
import { getTodayRandomStatus } from 'src/common/utils/randomStatus';

interface RecruitmentSession {
  channelId: string;
  messageId: string;
  createdAt: number;
  participants: Set<string>;
  nonParticipants: Set<string>;
  timer: NodeJS.Timeout;
  active: boolean;
  dateString: string; // "mm월 dd일" 형식의 문자열
}

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  private client: Client;
  // 채널별 활성 모집 세션 (하나의 채널에는 한 개의 활성 세션만 존재)
  private recruitmentSessions: Map<string, RecruitmentSession> = new Map();

  constructor() {
    // Guilds, 메시지 관련 인텐트를 활성화
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });
  }

  onModuleInit() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      this.logger.error(
        'DISCORD_TOKEN이 .env에 정의되어 있지 않습니다.',
        token,
      );
      return;
    }

    this.client.once('ready', async () => {
      this.logger.log(`로그인 완료: ${this.client.user!.tag}`);

      this.client.user!.setPresence({
        activities: [
          {
            name: getTodayRandomStatus(),
            type: ActivityType.Playing,
          },
        ],
        status: 'online',
      });

      // 슬래시 명령어 등록
      // (참고: 슬래시 명령어 이름은 Discord의 제약사항에 따라 일반적으로 영문 소문자여야 하지만, 여기서는 설명에 맞춰 "5?"와 "취소"로 사용)
      const commands = [
        {
          name: '5',
          description: '5인큐 모집 시작',
        },
        {
          name: '취소',
          description: '현재 모집을 취소합니다.',
        },
        {
          name: '사다리',
          description: '사다리 게임을 시작합니다.',
        },
      ];

      // 글로벌 명령어로 등록 (테스트 시에는 특정 길드에 등록하면 빠르게 적용됨)
      const rest = new REST({ version: '10' }).setToken(token);
      const guildId = process.env.DISCORD_GUILD_ID;
      if (!guildId) {
        this.logger.warn('DISCORD_GUILD_ID가 .env에 정의되어 있지 않습니다.');
      }
      try {
        if (guildId) {
          // 길드 명령어로 등록
          await rest.put(
            Routes.applicationGuildCommands(this.client.user!.id, guildId),
            {
              body: commands,
            },
          );
          this.logger.log('길드 슬래시 명령어가 성공적으로 등록되었습니다.');
        } else {
          // 전역 명령어 등록
          await rest.put(Routes.applicationCommands(this.client.user!.id), {
            body: commands,
          });
          this.logger.log('전역 슬래시 명령어가 성공적으로 등록되었습니다.');
        }
      } catch (error) {
        this.logger.error('슬래시 명령어 등록 중 에러 발생:', error);
      }
    });

    // 상호작용 이벤트 처리
    this.client.on('interactionCreate', async (interaction: Interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.handleCommand(interaction);
        } else if (interaction.isButton()) {
          await this.handleButton(interaction);
        }
      } catch (error) {
        this.logger.error('상호작용 처리 중 에러:', error);
      }
    });

    this.client.login(token);
  }

  // 슬래시 명령어 (/5 와 /취소) 처리
  private async handleCommand(interaction: ChatInputCommandInteraction) {
    const { commandName, channelId, user, channel } = interaction;
    if (!channel || !(channel instanceof TextChannel)) {
      await interaction.reply({
        content: '이 명령어는 텍스트 채널에서만 사용할 수 있습니다.',
        ephemeral: true,
      });
      return;
    }

    if (commandName === '5') {
      // 채널에 활성 모집 세션이 없으면 새로 생성, 있으면 참여 토글
      let session = this.recruitmentSessions.get(channelId);
      if (!session || !session.active) {
        const now = new Date();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const dateString = `${month}월 ${day}일`;
        const participants = new Set<string>();
        participants.add(user.id); // 처음 명령어 입력자는 자동 참여
        const nonParticipants = new Set<string>();

        // 두 개의 버튼 생성: 참여, 불참
        const participateButton = new ButtonBuilder()
          .setCustomId('participate_button')
          .setLabel('참여')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(false);
        const nonParticipateButton = new ButtonBuilder()
          .setCustomId('non_participate_button')
          .setLabel('불참')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(false);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          participateButton,
          nonParticipateButton,
        );

        const content = `🎮  ${dateString} 5인큐 모집  🎮\n\n[참여자]\n<@${user.id}>\n\n[불참자]\n없음`;
        const sentMessage = await channel.send({ content, components: [row] });

        // 12시간 후(43200000ms) 자동 버튼 비활성화 처리
        const timer = setTimeout(() => {
          this.disableRecruitment(channelId);
        }, 43200000);

        session = {
          channelId,
          messageId: sentMessage.id,
          createdAt: Date.now(),
          participants,
          nonParticipants,
          timer,
          active: true,
          dateString,
        };

        this.recruitmentSessions.set(channelId, session);

        await interaction.reply({
          content: '모집이 시작되었습니다!',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        // 이미 활성 모집 세션이 있을 경우, 현재 모집 진행상황을 다시 보여줍니다.
        const recruitmentMessage = await channel.messages.fetch(
          session.messageId,
        );
        await interaction.reply({
          content: recruitmentMessage.content,
          flags: MessageFlags.Ephemeral,
        });
      }
    } else if (commandName === '취소') {
      // 활성 모집 세션이 있으면 취소 처리
      const session = this.recruitmentSessions.get(channelId);
      if (session && session.active) {
        clearTimeout(session.timer);
        session.active = false;
        await this.disableRecruitment(channelId, channel);
        await interaction.reply({
          content: '모집이 취소되었습니다.',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: '활성화된 모집이 없습니다.',
          ephemeral: true,
        });
      }
    } else if (commandName === '사다리') {
      // 모집 세션 확인
      const session = this.recruitmentSessions.get(channelId);
      if (!session) {
        await interaction.reply({
          content: '5인큐 모임이 없습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // 참여 인원이 5명 이하인 경우
      if (session.participants.size <= 5) {
        await interaction.reply({
          content: '인원이 5명 이하입니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // 참여자 목록을 배열로 변환 후 무작위로 섞음
      const participantsArray = Array.from(session.participants);
      const shuffled = participantsArray.sort(() => Math.random() - 0.5);

      // 첫 5명은 '출격', 나머지는 '탈출'
      const goOut = shuffled.slice(0, 5);
      const escape = shuffled.slice(5);

      // Embed 메시지 작성
      const embed = {
        title: '사다리 게임 결과',
        description: '랜덤으로 역할이 할당되었습니다.',
        fields: [
          {
            name: '출격',
            value: goOut.map((id) => `<@${id}>`).join('\n') || '없음',
            inline: true,
          },
          {
            name: '탈출',
            value: escape.map((id) => `<@${id}>`).join('\n') || '없음',
            inline: true,
          },
        ],
        color: 0x00ff00,
      };

      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({
        content: '알 수 없는 명령어입니다.',
        ephemeral: true,
      });
    }
  }

  // 버튼 클릭 시 참여/취소 토글 처리
  private async handleButton(interaction: ButtonInteraction) {
    const { channelId, user, channel } = interaction;
    if (!channel || !(channel instanceof TextChannel)) {
      await interaction.reply({
        content: '이 버튼은 텍스트 채널에서만 사용할 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const session = this.recruitmentSessions.get(channelId);
    if (!session || !session.active) {
      await interaction.reply({
        content: '현재 활성화된 모집이 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // 이미 선택한 경우에는 재선택 불가
    if (
      session.participants.has(user.id) ||
      session.nonParticipants.has(user.id)
    ) {
      await interaction.reply({
        content: '이미 선택하셨습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId === 'participate_button') {
      session.participants.add(user.id);
      await interaction.reply({
        content: '참여 상태가 업데이트되었습니다.',
        flags: MessageFlags.Ephemeral,
      });
    } else if (interaction.customId === 'non_participate_button') {
      session.nonParticipants.add(user.id);
      await interaction.reply({
        content: '불참 상태가 업데이트되었습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await this.updateRecruitmentMessage(session, channel);
  }

  // 모집 메시지 업데이트 (참여자 목록 및 버튼 활성/비활성 상태)
  private async updateRecruitmentMessage(
    session: RecruitmentSession,
    channel: TextChannel,
  ) {
    try {
      const message = await channel.messages.fetch(session.messageId);
      // 버튼은 그대로 두고...
      const participateButton = new ButtonBuilder()
        .setCustomId('participate_button')
        .setLabel('참여')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(false);
      const nonParticipateButton = new ButtonBuilder()
        .setCustomId('non_participate_button')
        .setLabel('불참')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(false);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        participateButton,
        nonParticipateButton,
      );

      const participantsList =
        session.participants.size > 0
          ? Array.from(session.participants)
              .map((id) => `<@${id}>`)
              .join('\n')
          : '없음';
      const nonParticipantsList =
        session.nonParticipants.size > 0
          ? Array.from(session.nonParticipants)
              .map((id) => `<@${id}>`)
              .join('\n')
          : '없음';
      const content = `${session.dateString} 5인큐 모집\n\n[참여자]\n${participantsList}\n\n[불참자]\n${nonParticipantsList}`;
      await message.edit({ content, components: [row] });
    } catch (error) {
      this.logger.error('모집 메시지 업데이트 중 에러:', error);
    }
  }

  // 모집 세션 비활성화 (12시간 경과 또는 /취소 명령어 시)
  private async disableRecruitment(
    channelId: string,
    channelOverride?: TextChannel,
  ) {
    const session = this.recruitmentSessions.get(channelId);
    if (!session) return;
    session.active = false;
    let channel: TextChannel;
    if (channelOverride) {
      channel = channelOverride;
    } else {
      const fetchedChannel = await this.client.channels.fetch(channelId);
      if (!fetchedChannel || !(fetchedChannel instanceof TextChannel)) return;
      channel = fetchedChannel;
    }
    try {
      const message = await channel.messages.fetch(session.messageId);
      // 버튼을 비활성화하여 모집 종료 처리

      const participateButton = new ButtonBuilder()
        .setCustomId('participate_button')
        .setLabel('참여')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true);
      const nonParticipateButton = new ButtonBuilder()
        .setCustomId('non_participate_button')
        .setLabel('불참')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        participateButton,
        nonParticipateButton,
      );
      const newContent = message.content + '\n\n[모집 종료]';
      await message.edit({ content: newContent, components: [row] });
    } catch (error) {
      this.logger.error('모집 종료 처리 중 에러:', error);
    }
    this.recruitmentSessions.delete(channelId);
  }
}
