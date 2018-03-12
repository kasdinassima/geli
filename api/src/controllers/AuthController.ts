import {Request} from 'express';
import {
  Body, Post, JsonController, Req, HttpError, UseBefore, BodyParam, ForbiddenError,
  InternalServerError, BadRequestError, OnUndefined
} from 'routing-controllers';
import {json as bodyParserJson} from 'body-parser';
import passportLoginMiddleware from '../security/passportLoginMiddleware';
import emailService from '../services/EmailService';
import {IUser} from '../../../shared/models/IUser';
import {IUserModel, User} from '../models/User';
import {JwtUtils} from '../security/JwtUtils';
import config from '../config/main';
import * as errorCodes from '../config/errorCodes'
import {Course} from '../models/Course';

@JsonController('/auth')
export class AuthController {

  /**
   * @api {post} /api/login Login user
   * @apiName PostLogin
   * @apiGroup Auth
   *
   * @apiParam {Request} request Login request.
   *
   * @apiSuccess {String} token Generated access token.
   * @apiSuccess {IUserModel} user Authenticated user.
   *
   * @apiSuccessExample {json} Success-Response:
   *     {
   *         "token": "JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI1YTAzN2U2YTYwZjcyMjM2ZDhlN2M4MTMiLCJpYXQiOjE1MTcyNTI0NDYsImV4cCI6MTUxNzI2MjUyNn0.b53laxHG-b6FbB7JP1GJsIgGWc3EUm0cTuufm1CKCCM",
   *         "user": TODO
   *     }
   */
  @Post('/login')
  @UseBefore(bodyParserJson(), passportLoginMiddleware) // We need body-parser for passport to find the credentials
  postLogin(@Req() request: Request) {
    const user = <IUserModel>(<any>request).user;

    return {
      token: 'JWT ' + JwtUtils.generateToken(user),
      user: user.toObject()
    };
  }

  /**
   * @api {post} /api/register Register user
   * @apiName PostRegister
   * @apiGroup Auth
   *
   * @apiParam {IUser} user New user to be registered.
   *
   * @apiSuccess {Todo} todo Todo.
   *
   * @apiSuccessExample {json} Success-Response:
   *     {
   *         TODO
   *     }
   *
   * @apiError BadRequestError That matriculation number is already in use
   * @apiError BadRequestError That email address is already in use
   * @apiError BadRequestError You can only sign up as student or teacher
   * @apiError BadRequestError You are not allowed to register as teacher
   * @apiError InternalServerError Could not send E-Mail
   */
  @Post('/register')
  @OnUndefined(204)
  async postRegister(@Body() user: IUser) {
    const existingUser = await User.findOne({$or: [{email: user.email}, {uid: user.uid}]});
    // If user is not unique, return error
    if (existingUser) {
      if (user.role === 'student' && existingUser.uid === user.uid) {
        throw new BadRequestError(errorCodes.errorCodes.duplicateUid.code);
      }
      if (existingUser.email === user.email) {
        throw new BadRequestError(errorCodes.errorCodes.mail.duplicate.code);
      }
    }
    if (user.role !== 'teacher' && user.role !== 'student') {
      throw new BadRequestError('You can only sign up as student or teacher');
    }
    if (user.role === 'teacher' && (typeof user.email !== 'string' || !user.email.match(config.teacherMailRegex))) {
      throw new BadRequestError(errorCodes.errorCodes.mail.noTeacher.code);
    }
    const newUser = new User(user);
    const savedUser = await newUser.save();
    // User can now match a whitelist.
    await this.addWhitelistetUserToCourses(savedUser);
    try {
      emailService.sendActivation(savedUser);
    } catch (err) {
      throw new InternalServerError(errorCodes.errorCodes.mail.notSend.code);
    }
  }

  /**
   * @api {post} /api/activate Activate user
   * @apiName PostActivate
   * @apiGroup Auth
   *
   * @apiParam {string} authenticationToken Authentication token.
   *
   * @apiSuccess {Boolean} success Confirmation of activation.
   *
   * @apiSuccessExample {json} Success-Response:
   *     {
   *         "success": true
   *     }
   *
   * @apiError HttpError 422 - could not activate user
   */
  // TODO If activate user and is in playlist add to course.
  @Post('/activate')
  postActivation(@BodyParam('authenticationToken') authenticationToken: string) {
    return User.findOne({authenticationToken: authenticationToken})
      .then((existingUser) => {
        if (!existingUser) {
          throw new HttpError(422, 'could not activate user');
        }

        existingUser.authenticationToken = undefined;
        existingUser.isActive = true;
        return existingUser.save();
      })
      .then((user) => {
        return {success: true};
      });
  }

  @Post('/reset')
  postPasswordReset(@BodyParam('resetPasswordToken') resetPasswordToken: string, @BodyParam('newPassword') newPassword: string) {
    return User.findOne({resetPasswordToken: resetPasswordToken})
      .then((existingUser) => {
        if (!existingUser) {
          throw new HttpError(422, 'could not reset users password');
        }
        if (existingUser.resetPasswordExpires < new Date()) {
          throw new ForbiddenError('your reset password token is expired');
        }

        existingUser.password = newPassword;
        existingUser.resetPasswordToken = undefined;
        existingUser.resetPasswordExpires = undefined;
        existingUser.markModified('password');
        return existingUser.save();
      })
      .then((savedUser) => {
        return {success: true};
      });
  }

  @Post('/requestreset')
  postRequestPasswordReset(@BodyParam('email') email: string) {
    return User.findOne({email: email})
      .then((existingUser) => {
        if (!existingUser) {
          throw new HttpError(422, 'could not reset users password');
        }

        const expires = new Date();
        expires.setTime((new Date()).getTime()
          // Add 24h
          + (24 * 60 * 60 * 1000));

        existingUser.resetPasswordExpires = expires;
        return existingUser.save();
      })
      .then((user) => {
        return emailService.sendPasswordReset(user);
      })
      .then(() => {
        return {success: true};
      })
      .catch((err) => {
        throw new InternalServerError('Could not send E-Mail');
      });
  }

  /**
   * Add new user to all whitelistet courses in example after registration.
   * @param {IUser} user
   * @returns {Promise<void>}
   */
  private async addWhitelistetUserToCourses(user: IUser) {
    const courses = await Course.find(
      {enrollType: 'whitelist'}).populate('whitelist');

    await Promise.all(
      courses.map(async (course) => {
        if (course.students.findIndex(u => user._id === u._id < 0)
          && course.whitelist.find(w =>
            w.uid === user.uid)
        ) {
          course.students.push(user);
          await Course.update({_id: course._id}, course);
        }
      }));
  }
}
