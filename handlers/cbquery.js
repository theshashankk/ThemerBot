const env = require(`../env`);
const Sentry = require(`@sentry/node`);
const { asyncHandler } = require(`../middleware/errors`);
const debug = require(`debug`)(`themerbot:handlers:cbquery`);

const messageNotModified = `Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message`;
const queryTooOld = `Bad Request: query is too old and response timeout expired or query ID is invalid`;

async function saveColorToTheme({ ctx, theme, themeId, color, label }) {
    debug(`Saving color to theme`);
    if (theme.using[0] && theme.using[0].color === color) {
        try {
            debug(`Not allowing to use color`);
            return ctx.answerCbQuery(ctx.i18n(`cant_reuse_bg`));
        } catch (error) {
            if (error.description !== queryTooOld) {
                debug(error);
                Sentry.captureException(error);
                return;
            }
        }
    }

    theme.using.push({ color, label });
    debug(`Saving theme to storage`);
    await ctx.saveTheme(themeId, theme);

    debug(`Generating keyboard`);
    const keyboard = ctx.keyboard(true);
    const { length } = theme.using;

    debug(`Editing message`);
    if (length < 3) {
        await ctx.editMessageCaption(
            ctx.i18n(`choose_color_${length + 1}`, {
                colors: ctx.labelColors(theme.using).join(`, `),
            }),
            { reply_markup: keyboard },
        );
    } else {
        try {
            await ctx.editMessageCaption(ctx.i18n(`type_of_theme`), ctx.typeKeyboard());
        } catch (error) {
            if (error.description === messageNotModified) {
                try {
                    return await ctx.answerCbQuery(ctx.i18n(`dont_click`), true);
                } catch (error) {
                    if (error.description !== queryTooOld) {
                        debug(error);
                        Sentry.captureException(error);
                    }
                }
            } else {
                debug(error);
                Sentry.captureException(error);
            }
        }
    }
}

module.exports = bot => {
    bot.on(`callback_query`, asyncHandler(async ctx => {
        const { data } = ctx.callbackQuery;
        debug(`Handling button click: %s`, data);
        const { message_id: themeId } = ctx.callbackQuery.message;
        debug(`Fetching theme from storage`);
        const theme = await ctx.getTheme(themeId);
        debug(`Fetched theme`);

        if (data.startsWith(`cancel`)) {
            if (Number(data.split(`,`).pop()) === ctx.from.id) {
                await ctx.deleteMessage();
                await ctx.saveTheme(themeId, null);
            } else {
                try {
                    await ctx.answerCbQuery(ctx.i18n(`not_your_theme`));
                } catch (error) {
                    if (error.description !== queryTooOld) {
                        debug(error);
                        Sentry.captureException(error);
                    }
                }
            }

            return;
        }

        if (!theme) {
            try {
                await ctx.answerCbQuery(ctx.i18n(`no_theme_found`), true);
            } catch (error) {
                if (error.description !== queryTooOld) {
                    debug(error);
                    Sentry.captureException(error);
                }
            }

            return;
        }

        switch (data) {
            // Default button
            case `default`: {
                await ctx.editMessageCaption(
                    ctx.i18n(`type_of_theme`),
                    ctx.typeKeyboard(),
                );

                const { colors } = theme;

                // eslint-disable-next-line require-atomic-updates
                theme.using = [
                    { label: `1`, color: colors[0] },
                    { label: `5`, color: colors[4] },
                    { label: `4`, color: colors[3] },
                    { label: `2`, color: colors[1] },
                ];

                await ctx.saveTheme(themeId, theme);

                break;
            }

            // Backspace
            case `-`: {
                theme.using.pop();
                await ctx.saveTheme(themeId, theme);

                const { length } = theme.using;
                const keyboard = ctx.keyboard(length > 0);

                await ctx.editMessageCaption(
                    ctx.i18n(`choose_color_${length + 1}`, {
                        colors: ctx.labelColors(theme.using).join(`, `),
                    }),
                    { reply_markup: keyboard },
                );

                break;
            }

            case `white`: {
                await saveColorToTheme({
                    ctx,
                    theme,
                    themeId,
                    color: `#ffffff`,
                    label: `White`,
                });
                break;
            }

            case `black`: {
                await saveColorToTheme({
                    ctx,
                    theme,
                    themeId,
                    color: `#000000`,
                    label: `Black`,
                });
                break;
            }

            case `tgios-theme`:
            case `tgx-theme`:
            case `attheme`: {
                const { photo, using } = theme;
                debug(`Generating theme name`);
                const name = ctx.makeThemeName(using[0].color, using[2].color);
                debug(`Generated theme name: %s`, name);

                debug(`Generating theme`);
                const completedTheme = ctx.makeTheme({
                    type: data,
                    name: name,
                    image: await ctx.getThemePhoto(photo),
                    colors: using,
                });
                debug(`Generated theme`);

                const caption = [
                    `Made by @${ctx.botInfo.username}`,
                    `#theme ${ctx.labelColors(using, false).join(` `)}`,
                ];

                if (env.STRIPE_TOKEN) {
                    caption.push(``);
                    caption.push(
                        `If you'd like to help support the bot, please <a href="https://t.me/${ctx.botInfo.username}?start=donate">donate</a>.`,
                    );
                }

                debug(`Editing message to theme`);
                const { message_id } = await ctx.editMessageMedia({
                    caption: caption.join(`\n`),
                    type: `document`,
                    media: {
                        source: Buffer.from(completedTheme, `binary`),
                        filename: `${name} by @${ctx.botInfo.username}.${data}`,
                    },
                }, {
                    parse_mode: `HTML`,
                });
                debug(`Edited message to theme`);

                debug(`Generating theme preview`);
                let preview = ctx.createThemePreview({
                    name,
                    type: data,
                    theme: completedTheme,
                });

                preview = await preview;
                debug(`Generated theme preview`);
                if (preview) {
                    debug(`Sending preview`);
                    await ctx.replyWithPhoto(
                        { source: preview },
                        {
                            caption: `Preview by @${ctx.botInfo.username}.${data}`,
                            reply_to_message_id: message_id,
                        },
                    );
                } else {
                    debug(`%s themes don't support previews`, data);
                }

                debug(`Deleting theme from storage`);
                await ctx.saveTheme(themeId, null);
                break;
            }

            // All colors and type
            default: {
                const _data = Number(data);
                await saveColorToTheme({
                    ctx,
                    theme,
                    themeId,
                    color: theme.colors[_data],
                    label: _data + 1,
                });
            }
        }

        debug(`Answering callback query`);
        try {
            await ctx.answerCbQuery();
        } catch (error) {
            if (error.description !== queryTooOld) {
                debug(error);
                Sentry.captureException(error);
            }
        }
    }));
};
