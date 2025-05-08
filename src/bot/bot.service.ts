/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
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
  Message,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getTodayRandomStatus } from 'src/common/utils/randomStatus';

interface RecruitmentSession {
  channelId: string;
  messageIds: Set<string>;
  createdAt: number;
  participants: Set<string>;
  lateParticipants: Map<string, string>;
  nonParticipants: Set<string>;
  timer: NodeJS.Timeout;
  active: boolean;
  dateString: string;
  expirationTime: number;
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
        {
          name: '연장',
          description: '모집 시간을 연장합니다.',
          options: [
            {
              name: 'time',
              description: '연장할 시간(최대 12시간, 단위: 시간)',
              type: 4, // INTEGER 타입 (Discord API에서 정수 타입)
              required: true,
            },
          ],
        },
        {
          name: '활동',
          description: '봇 활동 상태를 변경합니다. (랜덤 또는 "원하는 텍스트")',
          options: [
            {
              name: 'text',
              description:
                '랜덤으로 설정하려면 랜덤, 직접 설정 시에는 따옴표 없이 텍스트 입력',
              type: 3, // STRING
              required: true,
            },
          ],
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
        // 1) 슬래시 커맨드
        if (interaction.isChatInputCommand()) {
          await this.handleCommand(interaction);

          // 2) 버튼 클릭
        } else if (interaction.isButton()) {
          await this.handleButton(interaction);

          // 3) Modal 제출
        } else if (
          interaction.isModalSubmit() &&
          interaction.customId === 'late_modal'
        ) {
          // ← 여기를 추가하세요
          const channel = interaction.channel as TextChannel;
          const session = this.recruitmentSessions.get(interaction.channelId!);
          if (!session || !session.active) {
            return interaction.reply({
              content: '현재 활성 모집이 없습니다.',
              ephemeral: true,
            });
          }
          const lateTime = interaction.fields
            .getTextInputValue('late_time_input')
            .trim();
          const userId = interaction.user.id;
          if (
            session.participants.has(userId) ||
            session.lateParticipants.has(userId) ||
            session.nonParticipants.has(userId)
          ) {
            return interaction.reply({
              content: '이미 선택하셨습니다.',
              ephemeral: true,
            });
          }
          session.lateParticipants.set(userId, lateTime);
          await this.updateRecruitmentMessage(session, channel);
          return interaction.reply({
            content: `✅ 늦참 시간: ${lateTime}`,
            ephemeral: true,
          });
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
        const date = new Date();
        const now = new Date(
          date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }),
        );
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const dateString = `${month}월 ${day}일`;
        const participants = new Set<string>();
        participants.add(user.id); // 처음 명령어 입력자는 자동 참여
        const nonParticipants = new Set<string>();
        const lateParticipants = new Map<string, string>();

        // 세 개의 버튼 생성: 참여, 불참
        const participateButton = new ButtonBuilder()
          .setCustomId('participate_button')
          .setLabel('참여')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(false);

        const lateButton = new ButtonBuilder()
          .setCustomId('late_participate_button')
          .setLabel('늦참')
          .setStyle(ButtonStyle.Success);

        const nonParticipateButton = new ButtonBuilder()
          .setCustomId('non_participate_button')
          .setLabel('불참')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(false);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          participateButton,
          lateButton,
          nonParticipateButton,
        );

        const content = `🎮  ${dateString} 5인큐 모집  🎮\n\n[참여자]\n<@${user.id}>\n\n[불참자]\n없음`;
        const sentMessage = await channel.send({ content, components: [row] });

        // 12시간 후(43200000ms) 자동 버튼 비활성화 처리
        const duration = 43200000; // 12시간 in ms
        const timer = setTimeout(() => {
          this.disableRecruitment(channelId);
        }, duration);

        session = {
          channelId,
          messageIds: new Set([sentMessage.id]),
          createdAt: Date.now(),
          participants,
          lateParticipants,
          nonParticipants,
          timer,
          active: true,
          dateString,
          expirationTime: Date.now() + duration, // 추가: 모집 만료 시간 저장
        };

        this.recruitmentSessions.set(channelId, session);

        await interaction.reply({
          content: '모집이 시작되었습니다!',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        // 기존: recruitmentMessage.content 만 reply
        const recruitmentMessage = await channel.messages.fetch(
          session.messageIds.values().next().value,
        );

        // public reply를 보낸 뒤 그 ID도 저장
        const replyMsg = (await interaction.reply({
          content: recruitmentMessage.content,
          components: recruitmentMessage.components ?? [],
          fetchReply: true,
        })) as Message;

        session.messageIds.add(replyMsg.id);
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
    } else if (commandName === '연장') {
      // extensionTime은 정수 값(시간 단위)로 받음
      const extensionTime = interaction.options.getInteger('time');
      if (extensionTime === null) {
        await interaction.reply({
          content: '연장할 시간을 숫자로 입력해주세요.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (extensionTime > 12) {
        await interaction.reply({
          content: '최대 12시간까지 연장 가능합니다.',
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

      // 기존 타이머 취소하고, 만료 시간 갱신 (추가 연장 시간: extensionTime * 3600000 ms)
      session.expirationTime += extensionTime * 3600000;
      clearTimeout(session.timer);
      const newDelay = session.expirationTime - Date.now();
      session.timer = setTimeout(() => {
        this.disableRecruitment(channelId);
      }, newDelay);

      await interaction.reply({
        content: `모집 시간이 ${extensionTime}시간 연장되었습니다.`,
        flags: MessageFlags.Ephemeral,
      });
    } else if (commandName === '활동') {
      const text = interaction.options.getString('text', true).trim();

      let statusText: string;
      if (text === '랜덤') {
        // 랜덤 명령어
        statusText = getTodayRandomStatus();
      } else {
        // 직접 입력 (따옴표 없이 입력)
        statusText = text;
      }

      // Presence 갱신
      this.client.user!.setPresence({
        activities: [
          {
            name: `${statusText}`,
            type: ActivityType.Playing,
          },
        ],
        status: 'online',
      });

      // 사용자에게 확인 메시지
      await interaction.reply({
        content: `🌟 활동 상태를 \`${statusText} 하는 중\` 으로 변경했습니다!`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: '알 수 없는 명령어입니다.',
        ephemeral: true,
      });
    }
  }

  // 버튼 클릭 시 참여/취소 토글 처리
  private async handleButton(interaction: ButtonInteraction) {
    const { customId, channelId, user, channel } = interaction;

    // 1) 텍스트 채널이 아니면 무시
    if (!channel || !(channel instanceof TextChannel)) {
      return interaction.reply({
        content: '이 버튼은 텍스트 채널에서만 사용할 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2) 활성 세션 가져오기
    const session = this.recruitmentSessions.get(channelId);
    if (!session || !session.active) {
      return interaction.reply({
        content: '현재 활성화된 모집이 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3) 이미 선택했는지 중복 검사
    if (
      session.participants.has(user.id) ||
      session.lateParticipants.has(user.id) ||
      session.nonParticipants.has(user.id)
    ) {
      return interaction.reply({
        content: '이미 선택하셨습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 4) 버튼별 처리
    if (customId === 'participate_button') {
      // 일반 참여
      session.participants.add(user.id);
      await interaction.reply({
        content: '참여 업데이트',
        flags: MessageFlags.Ephemeral,
      });
    } else if (customId === 'late_participate_button') {
      // *** 늦참 모달 띄우기 ***
      const modal = new ModalBuilder()
        .setCustomId('late_modal')
        .setTitle('늦참 시간 입력');

      const timeInput = new TextInputBuilder()
        .setCustomId('late_time_input')
        .setLabel('5인큐 참여 가능 시간을 입력하세요')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('예: 23시 또는 1시 반')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput),
      );

      return interaction.showModal(modal);
    } else if (customId === 'non_participate_button') {
      // 불참
      session.nonParticipants.add(user.id);

      await interaction.reply({
        content: '불참 상태가 업데이트되었습니다.',
        flags: MessageFlags.Ephemeral,
      });
    } else {
      // 그 외
      return;
    }

    // 5) 모든 참여/불참/늦참 메시지 갱신
    await this.updateRecruitmentMessage(session, channel as TextChannel);
  }

  // 모집 메시지 업데이트 (참여자 목록 및 버튼 활성/비활성 상태)
  private async updateRecruitmentMessage(
    session: RecruitmentSession,
    channel: TextChannel,
  ) {
    // 1) 버튼 재생성
    const participateButton = new ButtonBuilder()
      .setCustomId('participate_button')
      .setLabel('참여')
      .setStyle(ButtonStyle.Primary);
    const lateButton = new ButtonBuilder()
      .setCustomId('late_participate_button')
      .setLabel('늦참')
      .setStyle(ButtonStyle.Success);
    const nonParticipateButton = new ButtonBuilder()
      .setCustomId('non_participate_button')
      .setLabel('불참')
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      participateButton,
      lateButton,
      nonParticipateButton,
    );

    // 2) 텍스트 구성
    const normalList = Array.from(session.participants)
      .map((id) => `<@${id}>`)
      .join('\n');
    const lateList = Array.from(session.lateParticipants.entries())
      .map(([id, time]) => `<@${id}> (${time})`)
      .join('\n');
    const participantsList =
      [normalList, lateList].filter(Boolean).join('\n') || '없음';

    const nonList =
      Array.from(session.nonParticipants)
        .map((id) => `<@${id}>`)
        .join('\n') || '없음';

    const content =
      `🎮 ${session.dateString} 5인큐 모집 🎮\n\n` +
      `[참여자]\n${participantsList}\n\n` +
      `[불참자]\n${nonList}`;

    // 3) 모든 메시지에 대해 edit 호출
    for (const messageId of session.messageIds) {
      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.edit({ content, components: [row] });
      } catch {
        // 이미 삭제되었거나 권한이 없으면 무시
      }
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

    // 채널 가져오기
    let channel: TextChannel;
    if (channelOverride) {
      channel = channelOverride;
    } else {
      const fetched = await this.client.channels.fetch(channelId);
      if (!fetched || !(fetched instanceof TextChannel)) return;
      channel = fetched;
    }

    // 비활성화된 버튼 행 미리 생성
    const participateButton = new ButtonBuilder()
      .setCustomId('participate_button')
      .setLabel('참여')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true);
    const lateButton = new ButtonBuilder()
      .setCustomId('late_participate_button')
      .setLabel('늦참')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true);
    const nonParticipateButton = new ButtonBuilder()
      .setCustomId('non_participate_button')
      .setLabel('불참')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      participateButton,
      lateButton,
      nonParticipateButton,
    );

    // messageIds 모두 순회하며 edit
    for (const messageId of session.messageIds) {
      try {
        const msg = await channel.messages.fetch(messageId);
        const newContent = msg.content + '\n\n[모집 종료]';
        await msg.edit({ content: newContent, components: [row] });
      } catch {
        // 메시지가 삭제되었거나 접근 불가인 경우 무시
      }
    }

    this.recruitmentSessions.delete(channelId);
  }
}
